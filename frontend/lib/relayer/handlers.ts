import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { erc20Abi, toBytes, type Hex, type PublicClient } from 'viem';

import type { EvmTransactionRequest } from '@/lib/types/shared.types';
import {
  buildErc20TransferTx,
  serializeEvmTx,
  applyContractSafetyReduction,
} from '@/lib/evm/tx-builder';
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
import { fetchErc20Decimals, getTokenMetadata } from '@/lib/constants/token-metadata';

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
    const { orchestrator, provider, relayerWallet } =
      await initializeRelayerSetup({
        operationName: 'DEPOSIT',
        eventTimeoutMs: 60000,
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
      await updateTxStatus(trackingId, 'failed', {
        error: 'No balance detected after 5 minutes',
      });
      return { ok: false, error: 'No token balance detected' };
    }

    const processAmount = applyContractSafetyReduction(actualAmount);

    // Fetch decimals from chain (throws if token not in allowlist)
    const decimals = await fetchErc20Decimals(erc20Address);
    const tokenMetadata = getTokenMetadata(erc20Address);

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
      async (respondBidirectionalEvent, ethereumTxHash) => {
        const [pendingDepositPda] = derivePendingDepositPda(requestIdBytes);
        try {
          const pendingDeposit = (await dexContract.fetchPendingDeposit(
            pendingDepositPda,
          )) as { requester: PublicKey; erc20Address: number[] };
          const ethereumTxHashBytes = ethereumTxHash
            ? Array.from(toBytes(ethereumTxHash))
            : undefined;

          // Phase 5: Completing
          await updateTxStatus(trackingId, 'completing', { ethereumTxHash });

          return await dexContract.claimErc20({
            requester: pendingDeposit.requester,
            requestIdBytes,
            serializedOutput: respondBidirectionalEvent.serializedOutput,
            signature: respondBidirectionalEvent.signature,
            erc20AddressBytes: pendingDeposit.erc20Address,
            ethereumTxHashBytes,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (
            msg.includes('Account does not exist') ||
            msg.includes('AccountNotFound')
          ) {
            return 'already-claimed';
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
      await updateTxStatus(trackingId, 'failed', {
        error: result.error ?? 'Deposit failed',
      });
      return { ok: false, error: result.error ?? 'Deposit failed' };
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
    await updateTxStatus(trackingId, 'failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

export async function handleWithdrawal(args: {
  requestId: string;
  erc20Address: string;
  transactionParams: EvmTransactionRequest;
}) {
  return withEmbeddedSigner(() => executeWithdrawal(args));
}

async function executeWithdrawal(args: {
  requestId: string;
  erc20Address: string;
  transactionParams: EvmTransactionRequest;
}) {
  const { requestId, erc20Address, transactionParams } = args;

  // Update status to signature_pending (tx already registered in API route)
  await updateTxStatus(requestId, 'signature_pending');

  try {
    const { orchestrator } = await initializeRelayerSetup({
      operationName: 'WITHDRAW',
      eventTimeoutMs: 60000,
    });

    const result = await orchestrator.executeSignatureFlow(
      requestId,
      transactionParams,
      async (respondBidirectionalEvent, ethereumTxHash) => {
        const dexContract = orchestrator.getDexContract();
        const requestIdBytes = Array.from(toBytes(requestId));
        const [pendingWithdrawalPda] =
          derivePendingWithdrawalPda(requestIdBytes);
        const pendingWithdrawal = (await dexContract.fetchPendingWithdrawal(
          pendingWithdrawalPda,
        )) as unknown as { requester: string };
        const erc20AddressBytes = Array.from(toBytes(erc20Address));
        const ethereumTxHashBytes = ethereumTxHash
          ? Array.from(toBytes(ethereumTxHash))
          : undefined;

        // Phase: Completing
        await updateTxStatus(requestId, 'completing', { ethereumTxHash });

        return await dexContract.completeWithdrawErc20({
          requester: new PublicKey(pendingWithdrawal.requester),
          requestIdBytes,
          serializedOutput: respondBidirectionalEvent.serializedOutput,
          signature: respondBidirectionalEvent.signature,
          erc20AddressBytes,
          ethereumTxHashBytes,
        });
      },
      undefined,
      // onEthereumPending callback
      async () => {
        await updateTxStatus(requestId, 'ethereum_pending');
      },
    );

    if (!result.success) {
      await updateTxStatus(requestId, 'failed', {
        error: result.error ?? 'Withdrawal failed',
      });
      return { ok: false, error: result.error ?? 'Withdrawal failed' };
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
    await updateTxStatus(requestId, 'failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
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
      eventTimeoutMs: 60000,
    });
    const dexContract = orchestrator.getDexContract();
    const requestIdBytes = Array.from(toBytes(requestId));

    // For recovery, we only need to complete the claim step
    // The signature event should still be available if the original tx succeeded
    const result = await orchestrator.recoverSignatureFlow(
      requestId,
      async (respondBidirectionalEvent, ethereumTxHash) => {
        await updateTxStatus(requestId, 'completing', { ethereumTxHash });

        const ethereumTxHashBytes = ethereumTxHash
          ? Array.from(toBytes(ethereumTxHash))
          : undefined;

        return await dexContract.claimErc20({
          requester: pendingDeposit.requester,
          requestIdBytes,
          serializedOutput: respondBidirectionalEvent.serializedOutput,
          signature: respondBidirectionalEvent.signature,
          erc20AddressBytes: pendingDeposit.erc20Address,
          ethereumTxHashBytes,
        });
      },
    );

    if (!result.success) {
      await updateTxStatus(requestId, 'failed', {
        error: result.error ?? 'Recovery failed',
      });
      return { ok: false, error: result.error ?? 'Recovery failed' };
    }

    await updateTxStatus(requestId, 'completed', {
      solanaFinalizeTxHash: result.solanaResult,
    });

    return { ok: true, solanaTx: result.solanaResult };
  } catch (error) {
    await updateTxStatus(requestId, 'failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
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
      eventTimeoutMs: 60000,
    });
    const dexContract = orchestrator.getDexContract();
    const requestIdBytes = Array.from(toBytes(requestId));
    const erc20AddressBytes = Array.from(toBytes(erc20Address));

    const result = await orchestrator.recoverSignatureFlow(
      requestId,
      async (respondBidirectionalEvent, ethereumTxHash) => {
        await updateTxStatus(requestId, 'completing', { ethereumTxHash });

        const ethereumTxHashBytes = ethereumTxHash
          ? Array.from(toBytes(ethereumTxHash))
          : undefined;

        return await dexContract.completeWithdrawErc20({
          requester: new PublicKey(pendingWithdrawal.requester),
          requestIdBytes,
          serializedOutput: respondBidirectionalEvent.serializedOutput,
          signature: respondBidirectionalEvent.signature,
          erc20AddressBytes,
          ethereumTxHashBytes,
        });
      },
    );

    if (!result.success) {
      await updateTxStatus(requestId, 'failed', {
        error: result.error ?? 'Recovery failed',
      });
      return { ok: false, error: result.error ?? 'Recovery failed' };
    }

    await updateTxStatus(requestId, 'completed', {
      solanaFinalizeTxHash: result.solanaResult,
    });

    return { ok: true, solanaTx: result.solanaResult };
  } catch (error) {
    await updateTxStatus(requestId, 'failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
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

  while (Date.now() < deadline) {
    try {
      const balance = await client.readContract({
        address: tokenAddress as Hex,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address as Hex],
      });
      if (balance > 0n) return balance;
    } catch {
      // Swallow and retry - RPC errors are common
    }

    await sleep(intervalMs);
    intervalMs = Math.min(intervalMs * config.backoffMultiplier, config.maxIntervalMs);
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
