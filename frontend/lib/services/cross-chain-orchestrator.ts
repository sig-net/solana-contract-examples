import { Connection } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { ethers } from 'ethers';

import { BridgeContract } from '@/lib/contracts/bridge-contract';
import { ChainSignaturesContract } from '@/lib/contracts/chain-signatures-contract';
import type {
  EventPromises,
  ReadRespondedEvent,
} from '@/lib/types/chain-signatures.types';
import type { EvmTransactionRequest } from '@/lib/types/shared.types';
import { retryWithBackoff } from '@/lib/utils/retry';

export interface CrossChainConfig {
  eventTimeoutMs?: number;
  ethereumConfirmations?: number;
  operationName?: string;
}

export interface CrossChainResult {
  ethereumTxHash: string;
  success: boolean;
  error?: string;
}

export class CrossChainOrchestrator {
  private bridgeContract: BridgeContract;
  private chainSignaturesContract: ChainSignaturesContract;
  private provider: ethers.JsonRpcProvider;
  private config: Required<CrossChainConfig>;

  constructor(
    connection: Connection,
    wallet: Wallet,
    provider: ethers.JsonRpcProvider,
    config: CrossChainConfig = {},
    eventConnection?: Connection,
  ) {
    this.bridgeContract = new BridgeContract(connection, wallet);
    this.chainSignaturesContract = new ChainSignaturesContract(
      connection,
      wallet,
      eventConnection,
    );
    this.provider = provider;

    this.config = {
      // When eventTimeoutMs <= 0, we will wait indefinitely for events
      eventTimeoutMs: config.eventTimeoutMs ?? 300000,
      ethereumConfirmations: config.ethereumConfirmations ?? 1,
      operationName: config.operationName ?? 'OPERATION',
    };
  }

  async executeSignatureFlow<T>(
    requestId: string,
    ethereumTxParams: EvmTransactionRequest,
    solanaCompletionFn: (
      readEvent: ReadRespondedEvent,
      ethereumTxHash?: string,
    ) => Promise<T>,
    initialSolanaFn?: () => Promise<string>,
  ): Promise<
    CrossChainResult & { initialSolanaTxHash?: string; solanaResult?: T }
  > {
    const op = this.config.operationName;
    console.log(`[${op}] Starting signature flow for ${requestId}`);

    // Set up event listeners FIRST to prevent race conditions
    console.log(`[${op}] Setting up event listeners...`);
    const eventPromises =
      this.chainSignaturesContract.setupEventListeners(requestId);

    try {
      // Phase 1: Execute initial Solana transaction if provided (triggers signature generation)
      let initialSolanaTxHash: string | undefined;
      if (initialSolanaFn) {
        console.log(`[${op}] Executing initial Solana transaction...`);
        initialSolanaTxHash = await initialSolanaFn();
        console.log(`[${op}] Initial Solana tx: ${initialSolanaTxHash}`);
      }

      // Phase 2: Wait for signature and submit to Ethereum
      const ethereumTxHash = await this.executeEthereumTransaction(
        eventPromises,
        ethereumTxParams,
      );

      console.log(`[${op}] Ethereum tx: ${ethereumTxHash}`);

      // Phase 3: Wait for read response and complete on Solana
      console.log(`[${op}] Waiting for read response...`);
      const readEvent = await this.waitForReadResponse(eventPromises);

      console.log(`[${op}] Completing on Solana...`);
      const solanaResult = await solanaCompletionFn(readEvent, ethereumTxHash);

      console.log(`[${op}] Flow completed successfully`);

      return {
        ethereumTxHash,
        initialSolanaTxHash,
        success: true,
        solanaResult,
      };
    } catch (error) {
      console.error(error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error(`[${op}] Flow failed:`, errorMessage);

      return {
        ethereumTxHash: '',
        success: false,
        error: errorMessage,
      };
    } finally {
      console.log(`[${op}] Cleaning up event listeners`);
      eventPromises.cleanup();
    }
  }

  private async executeEthereumTransaction(
    eventPromises: EventPromises,
    txParams: EvmTransactionRequest,
  ): Promise<string> {
    const op = this.config.operationName;
    console.log(`[${op}] Waiting for signature...`);

    // Start a 30s delayed backfill for signature if it hasn't arrived yet
    const signatureBackfillTimeout = setTimeout(() => {
      void eventPromises.backfillSignature();
    }, 30000);

    const signatureEvent = await this.waitWithTimeout(
      eventPromises.signature,
      this.config.eventTimeoutMs,
      `Signature event timeout for ${op}`,
    ).finally(() => clearTimeout(signatureBackfillTimeout));

    console.log(`[${op}] Signature received`);

    const ethereumSignature = ChainSignaturesContract.extractSignature(
      signatureEvent.signature,
    );

    console.log(`[${op}] Submitting to Ethereum...`);

    const signedTx = ethers.Transaction.from({
      type: txParams.type,
      chainId: txParams.chainId,
      nonce: txParams.nonce,
      maxPriorityFeePerGas: txParams.maxPriorityFeePerGas,
      maxFeePerGas: txParams.maxFeePerGas,
      gasLimit: txParams.gasLimit,
      to: txParams.to,
      value: txParams.value,
      data: txParams.data,
      signature: {
        r: ethereumSignature.r,
        s: ethereumSignature.s,
        v: Number(ethereumSignature.v),
      },
    });

    const txResponse = await retryWithBackoff(() =>
      this.provider.broadcastTransaction(signedTx.serialized),
    );
    const txReceipt = await txResponse.wait(this.config.ethereumConfirmations);

    if (txReceipt?.status !== 1) {
      throw new Error(
        `Ethereum transaction failed with status: ${txReceipt?.status}`,
      );
    }

    return txResponse.hash;
  }

  private async waitForReadResponse(
    eventPromises: EventPromises,
  ): Promise<ReadRespondedEvent> {
    const op = this.config.operationName;

    // Start a 30s delayed backfill for read event if it hasn't arrived yet
    const readBackfillTimeout = setTimeout(() => {
      void eventPromises.backfillRead();
    }, 30000);

    return await this.waitWithTimeout(
      eventPromises.readRespond,
      this.config.eventTimeoutMs,
      `Read response timeout for ${op}`,
    ).finally(() => clearTimeout(readBackfillTimeout));
  }

  private async waitWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string,
  ): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]);
  }

  getBridgeContract(): BridgeContract {
    return this.bridgeContract;
  }
}
