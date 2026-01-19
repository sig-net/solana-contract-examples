import {
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  keccak256,
  serializeTransaction,
} from 'viem';

import type { EvmTransactionRequest } from '@/lib/types/shared.types';

export interface TxSubmitterConfig {
  maxBroadcastAttempts?: number;
  receiptTimeoutMs?: number;
  pollingIntervalMs?: number;
  confirmations?: number;
}

interface EthereumSignature {
  r: Hex;
  s: Hex;
  v: bigint;
}

interface SubmitResult {
  txHash: Hex;
  receipt: TransactionReceipt;
}

const DEFAULT_CONFIG: Required<TxSubmitterConfig> = {
  maxBroadcastAttempts: 3,
  receiptTimeoutMs: 180_000,
  pollingIntervalMs: 4_000,
  confirmations: 1,
};

/**
 * Submits an MPC-signed Ethereum transaction and waits for confirmation.
 *
 * NOTE: Gas bumping is NOT possible with MPC signatures because changing
 * gas values invalidates the signature. For better success rates, ensure
 * adequate gas buffer at signing time.
 *
 * Returns only after the receipt is confirmed on-chain.
 */
export async function submitWithRetry(
  client: PublicClient,
  txParams: EvmTransactionRequest,
  signature: EthereumSignature,
  config: TxSubmitterConfig = {},
): Promise<SubmitResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const signedTx = serializeTransaction(
    {
      chainId: txParams.chainId,
      nonce: txParams.nonce,
      maxPriorityFeePerGas: txParams.maxPriorityFeePerGas,
      maxFeePerGas: txParams.maxFeePerGas,
      gas: txParams.gasLimit,
      to: txParams.to,
      value: txParams.value,
      data: txParams.data,
    },
    {
      r: signature.r,
      s: signature.s,
      yParity: Number(signature.v) - 27,
    },
  );

  const txHash = keccak256(signedTx);
  await broadcastWithRetry(client, signedTx, cfg.maxBroadcastAttempts);

  const receipt = await waitForConfirmedReceipt(client, signedTx, txHash, cfg);

  return { txHash: receipt.transactionHash, receipt };
}

async function broadcastWithRetry(
  client: PublicClient,
  signedTx: Hex,
  maxAttempts: number,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.sendRawTransaction({ serializedTransaction: signedTx });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const msg = lastError.message.toLowerCase();

      if (msg.includes('nonce too low')) {
        throw new Error(`Nonce already used - transaction may have been mined or replaced`);
      }

      if (msg.includes('already known') || msg.includes('alreadyknown')) {
        return;
      }

      if (attempt < maxAttempts) {
        await sleep(2000 * attempt);
      }
    }
  }

  throw new Error(`Failed to broadcast after ${maxAttempts} attempts: ${lastError?.message}`);
}

async function waitForConfirmedReceipt(
  client: PublicClient,
  signedTx: Hex,
  txHash: Hex,
  cfg: Required<TxSubmitterConfig>,
): Promise<TransactionReceipt> {
  const startTime = Date.now();

  while (Date.now() - startTime < cfg.receiptTimeoutMs) {
    try {
      const receipt = await client.waitForTransactionReceipt({
        hash: txHash,
        confirmations: cfg.confirmations,
        timeout: Math.min(30_000, cfg.receiptTimeoutMs - (Date.now() - startTime)),
        pollingInterval: cfg.pollingIntervalMs,
      });

      if (receipt.status === 'reverted') {
        throw new Error(`Transaction reverted: ${txHash}`);
      }

      return receipt;
    } catch (error) {
      const msg = error instanceof Error ? error.message.toLowerCase() : '';

      if (msg.includes('reverted')) {
        throw error;
      }

      if (msg.includes('not found') || msg.includes('timeout')) {
        try {
          await client.sendRawTransaction({ serializedTransaction: signedTx });
        } catch (rebroadcastError) {
          const rebroadcastMsg =
            rebroadcastError instanceof Error
              ? rebroadcastError.message.toLowerCase()
              : '';
          if (
            !rebroadcastMsg.includes('already known') &&
            !rebroadcastMsg.includes('alreadyknown') &&
            !rebroadcastMsg.includes('nonce too low')
          ) {
            throw rebroadcastError;
          }
        }
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Transaction receipt timeout after ${cfg.receiptTimeoutMs}ms: ${txHash}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
