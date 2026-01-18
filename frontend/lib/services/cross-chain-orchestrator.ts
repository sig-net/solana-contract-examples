import { Connection } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { type Hex, type PublicClient } from 'viem';

import { DexContract } from '@/lib/contracts/dex-contract';
import { ChainSignaturesContract } from '@/lib/contracts/chain-signatures-contract';
import type {
  EventPromises,
  RespondBidirectionalEvent,
} from '@/lib/types/chain-signatures.types';
import type { EvmTransactionRequest } from '@/lib/types/shared.types';
import { submitWithRetry } from '@/lib/evm/tx-submitter';

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
  private dexContract: DexContract;
  private chainSignaturesContract: ChainSignaturesContract;
  private client: PublicClient;
  private config: Required<CrossChainConfig>;

  constructor(
    connection: Connection,
    wallet: Wallet,
    client: PublicClient,
    config: CrossChainConfig = {},
    eventConnection?: Connection,
  ) {
    this.dexContract = new DexContract(connection, wallet);
    this.chainSignaturesContract = new ChainSignaturesContract(
      connection,
      wallet,
      eventConnection,
    );
    this.client = client;

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
      respondBidirectionalEvent: RespondBidirectionalEvent,
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
      const respondBidirectionalEvent = await this.waitForRespondBidirectional(eventPromises);

      console.log(`[${op}] Completing on Solana...`);
      const solanaResult = await solanaCompletionFn(respondBidirectionalEvent, ethereumTxHash);

      console.log(`[${op}] Flow completed successfully`);

      return {
        ethereumTxHash,
        initialSolanaTxHash,
        success: true,
        solanaResult,
      };
    } catch (error) {
      console.error(error);
      if (error && typeof error === 'object' && 'logs' in error) {
        console.error(`[${op}] Transaction logs:`, (error as { logs: string[] }).logs);
      }
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

    console.log(`[${op}] Signature received:`, JSON.stringify(signatureEvent.signature));

    const ethereumSignature = ChainSignaturesContract.extractSignature(
      signatureEvent.signature,
    );

    console.log(`[${op}] Submitting to Ethereum...`);

    const { txHash, receipt } = await submitWithRetry(
      this.client,
      txParams,
      {
        r: ethereumSignature.r as Hex,
        s: ethereumSignature.s as Hex,
        v: ethereumSignature.v,
      },
      {
        maxBroadcastAttempts: 3,
        receiptTimeoutMs: 180_000,
      },
    );

    console.log(`[${op}] Receipt received:`, {
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed?.toString(),
    });

    return txHash;
  }

  private async waitForRespondBidirectional(
    eventPromises: EventPromises,
  ): Promise<RespondBidirectionalEvent> {
    const op = this.config.operationName;

    // Start a 30s delayed backfill for read event if it hasn't arrived yet
    const readBackfillTimeout = setTimeout(() => {
      void eventPromises.backfillRead();
    }, 30000);

    return await this.waitWithTimeout(
      eventPromises.respondBidirectional,
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

  getDexContract(): DexContract {
    return this.dexContract;
  }
}
