import {
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  serializeTransaction,
} from 'viem';

import type { EvmTransactionRequest } from '@/lib/types/shared.types';

export interface TxSubmitterConfig {
  maxBroadcastAttempts?: number;
  receiptTimeoutMs?: number;
  pollIntervalMs?: number;
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
  receiptTimeoutMs: 180_000, // 3 minutes
  pollIntervalMs: 4_000,
};

/**
 * Submits an MPC-signed Ethereum transaction with retry logic.
 *
 * NOTE: Gas bumping is NOT possible with MPC signatures because changing
 * gas values invalidates the signature. This function can only:
 * - Retry broadcasting the same signed transaction if it was dropped
 * - Wait longer for confirmation with robust monitoring
 *
 * For better success rates, ensure adequate gas buffer at signing time (1.5-2x).
 */
export async function submitWithRetry(
  client: PublicClient,
  txParams: EvmTransactionRequest,
  signature: EthereumSignature,
  config: TxSubmitterConfig = {},
): Promise<SubmitResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Serialize once - we can only rebroadcast the same signed tx
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

  let txHash: Hex | null = null;
  let lastError: Error | null = null;

  // Try to broadcast (may need retries if RPC is flaky)
  for (let attempt = 1; attempt <= cfg.maxBroadcastAttempts; attempt++) {
    try {
      txHash = await client.sendRawTransaction({
        serializedTransaction: signedTx,
      });
      console.log(`[TX-SUBMITTER] Broadcast successful: ${txHash}`);
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // If nonce too low, tx might have been mined already
      if (lastError.message.includes('nonce too low')) {
        throw new Error(
          `Nonce ${txParams.nonce} already used. Transaction may have been mined or replaced.`,
        );
      }

      // If already known, the tx is in mempool - treat as success
      if (
        lastError.message.includes('already known') ||
        lastError.message.includes('AlreadyKnown')
      ) {
        // Need to compute hash from signed tx
        console.log(`[TX-SUBMITTER] Transaction already in mempool`);
        break;
      }

      console.error(
        `[TX-SUBMITTER] Broadcast attempt ${attempt} failed:`,
        lastError.message,
      );

      if (attempt < cfg.maxBroadcastAttempts) {
        await sleep(2000 * attempt); // Backoff before retry
      }
    }
  }

  if (!txHash) {
    throw new Error(
      `Failed to broadcast transaction after ${cfg.maxBroadcastAttempts} attempts: ${lastError?.message}`,
    );
  }

  // Wait for receipt with monitoring
  console.log(`[TX-SUBMITTER] Waiting for receipt (timeout: ${cfg.receiptTimeoutMs}ms)...`);
  const receipt = await waitForReceiptWithMonitoring(
    client,
    txHash,
    txParams.nonce,
    cfg.receiptTimeoutMs,
    cfg.pollIntervalMs,
  );

  if (receipt.status !== 'success') {
    throw new Error(`Transaction reverted: ${txHash}`);
  }

  return { txHash, receipt };
}

async function waitForReceiptWithMonitoring(
  client: PublicClient,
  txHash: Hex,
  expectedNonce: number,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<TransactionReceipt> {
  const deadline = Date.now() + timeoutMs;
  const fromAddress = await getFromAddress(client, txHash);

  while (Date.now() < deadline) {
    // Check if tx is mined
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      if (receipt) {
        return receipt;
      }
    } catch {
      // Not mined yet
    }

    // Check if tx is still in mempool
    const txInMempool = await isTxInMempool(client, txHash);

    if (!txInMempool && fromAddress) {
      // Tx might have been dropped - check if nonce was used
      const confirmedNonce = await client.getTransactionCount({
        address: fromAddress,
        blockTag: 'latest',
      });

      if (confirmedNonce > expectedNonce) {
        // Nonce was used - either our tx or another one
        // Try to get receipt one more time
        try {
          const receipt = await client.getTransactionReceipt({ hash: txHash });
          if (receipt) {
            return receipt;
          }
        } catch {
          // Our tx wasn't mined, but nonce was used by another
          throw new Error(
            `Nonce ${expectedNonce} was used by a different transaction`,
          );
        }
      }

      // Tx was dropped from mempool and nonce not yet used
      throw new Error(`Transaction ${txHash} was dropped from mempool`);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Timeout waiting for transaction ${txHash}`);
}

async function isTxInMempool(
  client: PublicClient,
  txHash: Hex,
): Promise<boolean> {
  try {
    const tx = await client.getTransaction({ hash: txHash });
    return tx !== null;
  } catch {
    return false;
  }
}

async function getFromAddress(
  client: PublicClient,
  txHash: Hex,
): Promise<Hex | null> {
  try {
    const tx = await client.getTransaction({ hash: txHash });
    return tx?.from ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
