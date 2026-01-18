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
};

/**
 * Submits an MPC-signed Ethereum transaction with retry logic.
 *
 * NOTE: Gas bumping is NOT possible with MPC signatures because changing
 * gas values invalidates the signature. This function can only:
 * - Retry broadcasting the same signed transaction if it was dropped
 * - Wait longer for confirmation with robust monitoring
 *
 * For better success rates, ensure adequate gas buffer at signing time.
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

  const expectedTxHash = keccak256(signedTx);
  const txHash = await broadcastWithRetry(client, signedTx, expectedTxHash, cfg.maxBroadcastAttempts);

  // Verify tx is in mempool, re-broadcast if not
  await verifyInMempoolOrRebroadcast(client, signedTx, txHash);

  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    timeout: cfg.receiptTimeoutMs,
    pollingInterval: cfg.pollingIntervalMs,
    retryCount: 10,
    onReplaced: (replacement) => {
      console.log(`[TX-SUBMITTER] Transaction replaced:`, replacement.reason);
    },
  });

  if (receipt.status !== 'success') {
    throw new Error(`Transaction reverted: ${txHash}`);
  }

  return { txHash, receipt };
}

async function broadcastWithRetry(
  client: PublicClient,
  signedTx: Hex,
  expectedHash: Hex,
  maxAttempts: number,
): Promise<Hex> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const txHash = await client.sendRawTransaction({ serializedTransaction: signedTx });
      console.log(`[TX-SUBMITTER] Broadcast successful: ${txHash}`);
      return txHash;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const msg = lastError.message.toLowerCase();

      if (msg.includes('nonce too low')) {
        throw new Error(`Nonce already used - transaction may have been mined or replaced`);
      }

      if (msg.includes('already known') || msg.includes('alreadyknown')) {
        console.log(`[TX-SUBMITTER] Transaction already in mempool`);
        return expectedHash;
      }

      console.error(`[TX-SUBMITTER] Broadcast attempt ${attempt} failed:`, lastError.message);

      if (attempt < maxAttempts) {
        await sleep(2000 * attempt);
      }
    }
  }

  throw new Error(`Failed to broadcast after ${maxAttempts} attempts: ${lastError?.message}`);
}

async function verifyInMempoolOrRebroadcast(
  client: PublicClient,
  signedTx: Hex,
  txHash: Hex,
): Promise<void> {
  await sleep(2000);

  if (await isInMempool(client, txHash)) {
    return;
  }

  console.log(`[TX-SUBMITTER] TX not found in mempool, re-broadcasting...`);

  for (let retry = 1; retry <= 2; retry++) {
    try {
      await client.sendRawTransaction({ serializedTransaction: signedTx });
      console.log(`[TX-SUBMITTER] Re-broadcast ${retry} successful`);
      await sleep(2000);

      if (await isInMempool(client, txHash)) {
        console.log(`[TX-SUBMITTER] TX now in mempool`);
        return;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message.toLowerCase() : '';
      if (msg.includes('already known') || msg.includes('alreadyknown')) {
        console.log(`[TX-SUBMITTER] TX confirmed in mempool (already known)`);
        return;
      }
      console.log(`[TX-SUBMITTER] Re-broadcast ${retry} failed: ${msg}`);
    }
  }
}

async function isInMempool(client: PublicClient, txHash: Hex): Promise<boolean> {
  try {
    const tx = await client.getTransaction({ hash: txHash });
    return tx !== null;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
