import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { erc20Abi, toBytes, type Hex, type PublicClient } from 'viem';

import type { EvmTransactionRequest } from '@/lib/types/shared.types';
import {
  buildErc20TransferTx,
  serializeEvmTx,
  applyContractSafetyReduction,
} from '@/lib/evm/tx-builder';
import {
  ensureGasForErc20Transfer,
  ensureGasForTransaction,
} from '@/lib/evm/gas-topup';
import { initializeRelayerSetup } from '@/lib/utils/relayer-setup';
import { generateRequestId, evmParamsToProgram } from '@/lib/program/utils';
import { SERVICE_CONFIG } from '@/lib/constants/service.config';
import {
  VAULT_ETHEREUM_ADDRESS,
  deriveVaultAuthorityPda,
  derivePendingDepositPda,
  derivePendingWithdrawalPda,
} from '@/lib/constants/addresses';
import { withEmbeddedSigner } from '@/lib/relayer/embedded-signer';
import { updateTxStatus } from '@/lib/relayer/tx-registry';
import { fetchErc20Decimals, getErc20Token } from '@/lib/constants/token-metadata';

export async function handleDeposit(args: {
  userAddress: string;
  erc20Address: string;
  ethereumAddress: string;
  trackingId: string;
}) {
  return withEmbeddedSigner(() => executeDeposit(args));
}

async function executeDeposit(args: {
  userAddress: string;
  erc20Address: string;
  ethereumAddress: string;
  trackingId: string;
}) {
  const { userAddress, erc20Address, ethereumAddress, trackingId } = args;

  try {
    // Wait 12s for the user's deposit to land on the derived address
    console.log('[DEPOSIT] Waiting 12s for deposit to land on derived address...');
    await new Promise(resolve => setTimeout(resolve, 12000));
    console.log('[DEPOSIT] Initial wait complete, starting deposit flow');

    const { orchestrator, provider, relayerWallet } =
      await initializeRelayerSetup({
        operationName: 'DEPOSIT',
        eventTimeoutMs: 300000,
      });
    const dexContract = orchestrator.getDexContract();

    const userPublicKey = new PublicKey(userAddress);
    const [vaultAuthority] = deriveVaultAuthorityPda(userPublicKey);

    // Phase 1: Balance polling
    await updateTxStatus(trackingId, 'balance_polling');

    const actualAmount = await monitorTokenBalance(
      ethereumAddress,
      erc20Address,
      provider,
    );
    if (!actualAmount) {
      const balanceError = `No token balance detected at ${ethereumAddress} for token ${erc20Address} after 5 minutes`;
      await updateTxStatus(trackingId, 'failed', {
        error: balanceError,
      });
      return { ok: false, error: balanceError };
    }
    console.log(`[DEPOSIT] Token balance detected: ${actualAmount.toString()}`);

    const processAmount = applyContractSafetyReduction(actualAmount);

    // Fetch decimals from chain (throws if token not in allowlist)
    const decimals = await fetchErc20Decimals(erc20Address);
    const tokenMetadata = getErc20Token(erc20Address);

    // Phase 1.5: Gas top-up if needed
    const { topUpTxHash } = await ensureGasForErc20Transfer(
      provider,
      ethereumAddress as Hex,
      erc20Address as Hex,
      VAULT_ETHEREUM_ADDRESS,
      processAmount,
    );
    if (topUpTxHash) {
      console.log(`[DEPOSIT] Gas top-up sent: ${topUpTxHash}`);
      await updateTxStatus(trackingId, 'gas_topup_pending', {
        gasTopUpTxHash: topUpTxHash,
      });
    }

    const path = userAddress;
    const erc20AddressBytes = Array.from(toBytes(erc20Address as Hex));

    const txRequest: EvmTransactionRequest = await buildErc20TransferTx({
      provider,
      from: ethereumAddress,
      erc20Address,
      recipient: VAULT_ETHEREUM_ADDRESS,
      amount: processAmount,
    });

    const rlpEncodedTx = serializeEvmTx(txRequest);
    const requestId = generateRequestId(
      vaultAuthority,
      toBytes(rlpEncodedTx),
      SERVICE_CONFIG.ETHEREUM.CAIP2_ID,
      SERVICE_CONFIG.RETRY.DEFAULT_KEY_VERSION,
      path,
      SERVICE_CONFIG.CRYPTOGRAPHY.SIGNATURE_ALGORITHM,
      SERVICE_CONFIG.CRYPTOGRAPHY.TARGET_BLOCKCHAIN,
      '',
    );

    const requestIdBytes = Array.from(toBytes(requestId));
    const [pendingDepositPda] = derivePendingDepositPda(requestIdBytes);
    console.log(`[DEPOSIT] RequestId: ${requestId}, PDA: ${pendingDepositPda.toBase58()}`);

    const evmParams = evmParamsToProgram(txRequest);
    const amountBN = new BN(processAmount.toString());

    // Phase 2: Solana pending - link requestId and store token info
    await updateTxStatus(trackingId, 'solana_pending', {
      requestId,
      tokenMint: erc20Address,
      tokenAmount: processAmount.toString(),
      tokenDecimals: decimals,
      tokenSymbol: tokenMetadata?.symbol ?? 'Unknown',
    });

    const result = await orchestrator.executeSignatureFlow(
      requestId,
      txRequest,
      async (respondBidirectionalData, ethereumTxHash) => {
        const [pendingDepositPda] = derivePendingDepositPda(requestIdBytes);
        console.log(`[DEPOSIT] Attempting to claim. PDA: ${pendingDepositPda.toBase58()}, RequestID: ${requestId}`);
        try {
          const pendingDeposit = (await dexContract.fetchPendingDeposit(
            pendingDepositPda,
          )) as { requester: PublicKey; erc20Address: number[] };
          console.log(`[DEPOSIT] Found PendingDeposit. Requester: ${pendingDeposit.requester.toBase58()}`);
          const ethereumTxHashBytes = ethereumTxHash
            ? Array.from(toBytes(ethereumTxHash))
            : undefined;

          // Phase 5: Completing
          await updateTxStatus(trackingId, 'completing', { ethereumTxHash });

          const claimTxHash = await dexContract.claimErc20({
            requester: pendingDeposit.requester,
            requestIdBytes,
            serializedOutput: respondBidirectionalData.serializedOutput,
            signature: respondBidirectionalData.signature,
            erc20AddressBytes: pendingDeposit.erc20Address,
            ethereumTxHashBytes,
          });
          console.log(`[DEPOSIT] Claim successful! Tx: ${claimTxHash}`);
          return claimTxHash;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[DEPOSIT] Claim error: ${msg}`);
          if (
            msg.includes('Account does not exist') ||
            msg.includes('AccountNotFound')
          ) {
            throw new Error(
              `PendingDeposit not found for request ${requestId}. ` +
              `PDA: ${pendingDepositPda.toBase58()}. ` +
              `The deposit may have already been claimed or the initial deposit transaction failed.`
            );
          }
          throw e;
        }
      },
      async () => {
        const tx = await dexContract.depositErc20({
          requester: userPublicKey,
          payer: relayerWallet.publicKey,
          requestIdBytes,
          erc20AddressBytes,
          recipientAddressBytes: Array.from(toBytes(VAULT_ETHEREUM_ADDRESS)),
          amount: amountBN,
          evmParams,
        });

        // Phase 3: Signature pending
        await updateTxStatus(trackingId, 'signature_pending', {
          solanaInitTxHash: tx,
        });

        return tx;
      },
      // onEthereumPending callback
      async () => {
        // Phase 4: Ethereum pending
        await updateTxStatus(trackingId, 'ethereum_pending');
      },
    );

    if (!result.success) {
      const depositError = result.error ?? `Deposit flow failed for request ${trackingId}`;
      await updateTxStatus(trackingId, 'failed', {
        error: depositError,
      });
      return { ok: false, error: depositError };
    }

    // Phase 6: Completed
    await updateTxStatus(trackingId, 'completed', {
      ethereumTxHash: result.ethereumTxHash,
      solanaFinalizeTxHash: result.solanaResult,
    });

    return {
      ok: true as const,
      requestId,
      initialSolanaTxHash: result.initialSolanaTxHash,
      ethereumTxHash: result.ethereumTxHash,
      claimTx: result.solanaResult,
    };
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : `Unexpected error during deposit: ${String(error)}`;
    await updateTxStatus(trackingId, 'failed', {
      error: errorMessage,
    });
    throw error;
  }
}

export async function handleWithdrawal(args: {
  requestId: string;
  erc20Address: string;
  transactionParams: EvmTransactionRequest;
  solanaInitTxHash?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
}) {
  return withEmbeddedSigner(() => executeWithdrawal(args));
}

async function executeWithdrawal(args: {
  requestId: string;
  erc20Address: string;
  transactionParams: EvmTransactionRequest;
  solanaInitTxHash?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
}) {
  const { requestId, erc20Address, transactionParams, solanaInitTxHash, blockhash, lastValidBlockHeight } = args;

  try {
    const { orchestrator, provider } = await initializeRelayerSetup({
      operationName: 'WITHDRAW',
      eventTimeoutMs: 300000,
    });
    const dexContract = orchestrator.getDexContract();

    // Phase: Confirm Solana tx if we have the blockhash info
    if (solanaInitTxHash && blockhash && lastValidBlockHeight) {
      console.log(`[WITHDRAW] Confirming Solana tx: ${solanaInitTxHash}`);
      await updateTxStatus(requestId, 'solana_pending', { solanaInitTxHash });

      await dexContract.confirmTransactionOrThrow(
        solanaInitTxHash,
        blockhash,
        lastValidBlockHeight,
        'WITHDRAW',
      );
      console.log(`[WITHDRAW] Solana tx confirmed: ${solanaInitTxHash}`);
    }

    // Phase: Gas top-up for vault if needed
    const { topUpTxHash } = await ensureGasForTransaction(
      provider,
      VAULT_ETHEREUM_ADDRESS,
      transactionParams.gasLimit,
      transactionParams.maxFeePerGas,
    );
    if (topUpTxHash) {
      console.log(`[WITHDRAW] Gas top-up sent: ${topUpTxHash}`);
      await updateTxStatus(requestId, 'gas_topup_pending', {
        gasTopUpTxHash: topUpTxHash,
      });
    }

    // Update status to signature_pending
    await updateTxStatus(requestId, 'signature_pending');

    const result = await orchestrator.executeSignatureFlow(
      requestId,
      transactionParams,
      async (respondBidirectionalData, ethereumTxHash) => {
        const dexContract = orchestrator.getDexContract();
        const requestIdBytes = Array.from(toBytes(requestId));
        const [pendingWithdrawalPda] =
          derivePendingWithdrawalPda(requestIdBytes);

        console.log(`[WITHDRAW] Attempting to complete. PDA: ${pendingWithdrawalPda.toBase58()}, RequestID: ${requestId}`);

        let pendingWithdrawal: { requester: string };
        try {
          pendingWithdrawal = (await dexContract.fetchPendingWithdrawal(
            pendingWithdrawalPda,
          )) as unknown as { requester: string };
          console.log(`[WITHDRAW] Found PendingWithdrawal. Requester: ${pendingWithdrawal.requester}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[WITHDRAW] Failed to fetch PendingWithdrawal: ${msg}`);
          if (
            msg.includes('Account does not exist') ||
            msg.includes('AccountNotFound')
          ) {
            throw new Error(
              `PendingWithdrawal not found for request ${requestId}. ` +
              `PDA: ${pendingWithdrawalPda.toBase58()}. ` +
              `The withdrawal may have already been completed or the initial withdrawal transaction failed.`
            );
          }
          throw e;
        }

        const erc20AddressBytes = Array.from(toBytes(erc20Address));
        const ethereumTxHashBytes = ethereumTxHash
          ? Array.from(toBytes(ethereumTxHash))
          : undefined;

        // Phase: Completing
        await updateTxStatus(requestId, 'completing', { ethereumTxHash });

        const completeTxHash = await dexContract.completeWithdrawErc20({
          requester: new PublicKey(pendingWithdrawal.requester),
          requestIdBytes,
          serializedOutput: respondBidirectionalData.serializedOutput,
          signature: respondBidirectionalData.signature,
          erc20AddressBytes,
          ethereumTxHashBytes,
        });
        console.log(`[WITHDRAW] Complete successful! Tx: ${completeTxHash}`);
        return completeTxHash;
      },
      undefined,
      // onEthereumPending callback
      async () => {
        await updateTxStatus(requestId, 'ethereum_pending');
      },
    );

    if (!result.success) {
      const withdrawalError = result.error ?? `Withdrawal flow failed for request ${requestId}`;
      await updateTxStatus(requestId, 'failed', {
        error: withdrawalError,
      });
      return { ok: false, error: withdrawalError };
    }

    await updateTxStatus(requestId, 'completed', {
      ethereumTxHash: result.ethereumTxHash,
      solanaFinalizeTxHash: result.solanaResult,
    });

    return {
      ok: true as const,
      requestId,
      ethereumTxHash: result.ethereumTxHash,
      solanaTx: result.solanaResult,
    };
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : `Unexpected error during withdrawal: ${String(error)}`;
    await updateTxStatus(requestId, 'failed', {
      error: errorMessage,
    });
    throw error;
  }
}

// Recovery functions for stuck transactions
export async function recoverDeposit(
  requestId: string,
  pendingDeposit: { requester: PublicKey; erc20Address: number[] },
): Promise<{ ok: boolean; error?: string; solanaTx?: string }> {
  try {
    await updateTxStatus(requestId, 'signature_pending');

    const { orchestrator } = await initializeRelayerSetup({
      operationName: 'RECOVER_DEPOSIT',
      eventTimeoutMs: 300000,
    });
    const dexContract = orchestrator.getDexContract();
    const requestIdBytes = Array.from(toBytes(requestId));

    // For recovery, we only need to complete the claim step
    // The signature event should still be available if the original tx succeeded
    const result = await orchestrator.recoverSignatureFlow(
      requestId,
      async (respondBidirectionalData, ethereumTxHash) => {
        await updateTxStatus(requestId, 'completing', { ethereumTxHash });

        const ethereumTxHashBytes = ethereumTxHash
          ? Array.from(toBytes(ethereumTxHash))
          : undefined;

        return await dexContract.claimErc20({
          requester: pendingDeposit.requester,
          requestIdBytes,
          serializedOutput: respondBidirectionalData.serializedOutput,
          signature: respondBidirectionalData.signature,
          erc20AddressBytes: pendingDeposit.erc20Address,
          ethereumTxHashBytes,
        });
      },
    );

    if (!result.success) {
      const recoveryError = result.error ?? `Deposit recovery failed: no signature event found for ${requestId}`;
      await updateTxStatus(requestId, 'failed', {
        error: recoveryError,
      });
      return { ok: false, error: recoveryError };
    }

    await updateTxStatus(requestId, 'completed', {
      solanaFinalizeTxHash: result.solanaResult,
    });

    return { ok: true, solanaTx: result.solanaResult };
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : `Unexpected error during deposit recovery: ${String(error)}`;
    await updateTxStatus(requestId, 'failed', {
      error: errorMessage,
    });
    return {
      ok: false,
      error: errorMessage,
    };
  }
}

export async function recoverWithdrawal(
  requestId: string,
  pendingWithdrawal: { requester: string },
  erc20Address: string,
): Promise<{ ok: boolean; error?: string; solanaTx?: string }> {
  try {
    await updateTxStatus(requestId, 'signature_pending');

    const { orchestrator } = await initializeRelayerSetup({
      operationName: 'RECOVER_WITHDRAWAL',
      eventTimeoutMs: 300000,
    });
    const dexContract = orchestrator.getDexContract();
    const requestIdBytes = Array.from(toBytes(requestId));
    const erc20AddressBytes = Array.from(toBytes(erc20Address));

    const result = await orchestrator.recoverSignatureFlow(
      requestId,
      async (respondBidirectionalData, ethereumTxHash) => {
        await updateTxStatus(requestId, 'completing', { ethereumTxHash });

        const ethereumTxHashBytes = ethereumTxHash
          ? Array.from(toBytes(ethereumTxHash))
          : undefined;

        return await dexContract.completeWithdrawErc20({
          requester: new PublicKey(pendingWithdrawal.requester),
          requestIdBytes,
          serializedOutput: respondBidirectionalData.serializedOutput,
          signature: respondBidirectionalData.signature,
          erc20AddressBytes,
          ethereumTxHashBytes,
        });
      },
    );

    if (!result.success) {
      const recoveryError = result.error ?? `Withdrawal recovery failed: no signature event found for ${requestId}`;
      await updateTxStatus(requestId, 'failed', {
        error: recoveryError,
      });
      return { ok: false, error: recoveryError };
    }

    await updateTxStatus(requestId, 'completed', {
      solanaFinalizeTxHash: result.solanaResult,
    });

    return { ok: true, solanaTx: result.solanaResult };
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : `Unexpected error during withdrawal recovery: ${String(error)}`;
    await updateTxStatus(requestId, 'failed', {
      error: errorMessage,
    });
    return {
      ok: false,
      error: errorMessage,
    };
  }
}

// Enhanced balance monitoring with exponential backoff
async function monitorTokenBalance(
  address: string,
  tokenAddress: string,
  client: PublicClient,
): Promise<bigint | null> {
  const config = {
    maxDurationMs: 300_000, // 5 minutes total
    pollIntervalMs: 5_000, // Check every 5s
    backoffMultiplier: 1.2, // Increase interval on consecutive failures
    maxIntervalMs: 30_000, // Cap at 30s between checks
  };

  let intervalMs = config.pollIntervalMs;
  const deadline = Date.now() + config.maxDurationMs;

  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      const balance = await client.readContract({
        address: tokenAddress as Hex,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address as Hex],
      });
      if (balance > 0n) return balance;
      lastError = null; // Reset on successful read
    } catch (error) {
      // Log once per unique error to help debugging without flooding logs
      const currentError = error instanceof Error ? error : new Error(String(error));
      if (!lastError || lastError.message !== currentError.message) {
        console.warn(`[BalanceMonitor] RPC error for ${address}: ${currentError.message}`);
        lastError = currentError;
      }
    }

    await sleep(intervalMs);
    intervalMs = Math.min(intervalMs * config.backoffMultiplier, config.maxIntervalMs);
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
