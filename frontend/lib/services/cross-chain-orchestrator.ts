import { Connection } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { type Hex, type PublicClient } from 'viem';

import { DexContract } from '@/lib/contracts/dex-contract';
import { ChainSignaturesContract } from '@/lib/contracts/chain-signatures-contract';
import type {
  EventListenerResult,
  RespondBidirectionalData,
} from '@/lib/types/chain-signatures.types';
import type { EvmTransactionRequest } from '@/lib/types/shared.types';
import { submitWithRetry } from '@/lib/evm/tx-submitter';

export interface CrossChainConfig {
  eventTimeoutMs?: number;
  ethereumConfirmations?: number;
  operationName?: string;
  initialDelayMs?: number;
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
      initialDelayMs: config.initialDelayMs ?? 0,
    };
  }

  async executeSignatureFlow<T>(
    requestId: string,
    ethereumTxParams: EvmTransactionRequest,
    solanaCompletionFn: (
      respondBidirectionalData: RespondBidirectionalData,
      ethereumTxHash?: string,
    ) => Promise<T>,
    initialSolanaFn?: () => Promise<string>,
    onEthereumPending?: () => Promise<void>,
  ): Promise<
    CrossChainResult & { initialSolanaTxHash?: string; solanaResult?: T }
  > {
    const op = this.config.operationName;
    console.log(`[${op}] Starting signature flow for ${requestId}`);

    // Set up event listeners FIRST to prevent race conditions
    console.log(`[${op}] Setting up event listeners...`);
    const eventListeners =
      await this.chainSignaturesContract.setupEventListeners(requestId);

    try {
      // Optional initial delay (e.g., for deposits to land on derived address)
      if (this.config.initialDelayMs > 0) {
        console.log(`[${op}] Waiting ${this.config.initialDelayMs}ms before starting flow...`);
        await new Promise(resolve => setTimeout(resolve, this.config.initialDelayMs));
      }

      // Phase 1: Execute initial Solana transaction if provided (triggers signature generation)
      let initialSolanaTxHash: string | undefined;
      if (initialSolanaFn) {
        console.log(`[${op}] Executing initial Solana transaction...`);
        initialSolanaTxHash = await initialSolanaFn();
        console.log(`[${op}] Initial Solana tx: ${initialSolanaTxHash}`);
      }

      // Phase 2: Wait for signature and submit to Ethereum
      const ethereumTxHash = await this.executeEthereumTransaction(
        eventListeners,
        ethereumTxParams,
        onEthereumPending,
      );

      console.log(`[${op}] Ethereum tx: ${ethereumTxHash}`);

      // Phase 3: Wait for read response and complete on Solana
      console.log(`[${op}] Waiting for read response...`);
      const respondBidirectionalData = await this.waitForRespondBidirectional(eventListeners);

      console.log(`[${op}] Completing on Solana...`);
      const solanaResult = await solanaCompletionFn(respondBidirectionalData, ethereumTxHash);

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
      const errorMessage = error instanceof Error
        ? error.message
        : `Unexpected error in signature flow for ${requestId}: ${String(error)}`;
      console.error(`[${op}] Flow failed:`, errorMessage);

      return {
        ethereumTxHash: '',
        success: false,
        error: errorMessage,
      };
    } finally {
      console.log(`[${op}] Cleaning up event listeners`);
      eventListeners.cleanup();
    }
  }

  /**
   * Recovery flow - attempts to complete a stuck transaction by querying
   * historical events and completing the Solana side
   */
  async recoverSignatureFlow<T>(
    requestId: string,
    solanaCompletionFn: (
      respondBidirectionalData: RespondBidirectionalData,
      ethereumTxHash?: string,
    ) => Promise<T>,
  ): Promise<CrossChainResult & { solanaResult?: T }> {
    const op = this.config.operationName;
    console.log(`[${op}] Starting recovery flow for ${requestId}`);

    // Set up event listeners (backfill is handled automatically by waitForEvent)
    console.log(`[${op}] Setting up event listeners for recovery...`);
    const eventListeners =
      await this.chainSignaturesContract.setupEventListeners(requestId);

    try {
      // Wait for read response (from backfill or live)
      console.log(`[${op}] Waiting for read response...`);
      const respondBidirectionalData = await this.waitWithTimeout(
        eventListeners.respondBidirectional,
        this.config.eventTimeoutMs,
        `Read response timeout for recovery (requestId: ${requestId})`,
      );

      console.log(`[${op}] Completing on Solana...`);
      const solanaResult = await solanaCompletionFn(respondBidirectionalData, undefined);

      console.log(`[${op}] Recovery completed successfully`);

      return {
        ethereumTxHash: '',
        success: true,
        solanaResult,
      };
    } catch (error) {
      console.error(error);
      if (error && typeof error === 'object' && 'logs' in error) {
        console.error(`[${op}] Transaction logs:`, (error as { logs: string[] }).logs);
      }
      const errorMessage = error instanceof Error
        ? error.message
        : `Unexpected error in recovery flow for ${requestId}: ${String(error)}`;
      console.error(`[${op}] Recovery failed:`, errorMessage);

      return {
        ethereumTxHash: '',
        success: false,
        error: errorMessage,
      };
    } finally {
      console.log(`[${op}] Cleaning up event listeners`);
      eventListeners.cleanup();
    }
  }

  private async executeEthereumTransaction(
    eventListeners: EventListenerResult,
    txParams: EvmTransactionRequest,
    onEthereumPending?: () => Promise<void>,
  ): Promise<string> {
    const op = this.config.operationName;
    console.log(`[${op}] Waiting for signature...`);

    const signatureResult = await this.waitWithTimeout(
      eventListeners.signature,
      this.config.eventTimeoutMs,
      `Signature event timeout for ${op}`,
    );

    console.log(`[${op}] Signature received`);

    console.log(`[${op}] Submitting to Ethereum...`);

    // Notify that we're about to submit to Ethereum
    if (onEthereumPending) {
      await onEthereumPending();
    }

    const { txHash, receipt } = await submitWithRetry(
      this.client,
      txParams,
      {
        r: `0x${signatureResult.r}` as Hex,
        s: `0x${signatureResult.s}` as Hex,
        v: BigInt(signatureResult.v),
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
    eventListeners: EventListenerResult,
  ): Promise<RespondBidirectionalData> {
    const op = this.config.operationName;

    return await this.waitWithTimeout(
      eventListeners.respondBidirectional,
      this.config.eventTimeoutMs,
      `Read response timeout for ${op}`,
    );
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
