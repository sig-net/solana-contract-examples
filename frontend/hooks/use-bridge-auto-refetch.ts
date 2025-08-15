'use client';

import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useEffect, useMemo } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useQueryClient } from '@tanstack/react-query';
import type { Wallet } from '@coral-xyz/anchor';

import {
  BRIDGE_PROGRAM_ID,
  deriveUserBalancePda,
  deriveVaultAuthorityPda,
} from '@/lib/constants/addresses';
import { getAllErc20Tokens } from '@/lib/constants/token-metadata';
import { queryKeys } from '@/lib/query-client';
import { BridgeContract } from '@/lib/contracts/bridge-contract';

/**
 * OPTIMIZED: useBridgeAutoRefetch subscribes to on-chain logs for our program
 * Uses a single consolidated subscription instead of multiple individual ones
 *
 * This provides near-real-time updates for:
 * - Deposits: claimErc20
 * - Withdrawals: completeWithdrawErc20
 */
export function useBridgeAutoRefetch() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const queryClient = useQueryClient();

  const userBalancePdaSet = useMemo(() => {
    if (!publicKey) return new Set<string>();
    const set = new Set<string>();
    for (const token of getAllErc20Tokens()) {
      try {
        const erc20Bytes = Buffer.from(token.address.replace('0x', ''), 'hex');
        const [pda] = deriveUserBalancePda(publicKey, erc20Bytes);
        set.add(pda.toBase58());
      } catch {}
    }
    return set;
  }, [publicKey]);

  const requesterPdaBase58 = useMemo(() => {
    if (!publicKey) return null;
    try {
      const [pda] = deriveVaultAuthorityPda(publicKey);
      return pda.toBase58();
    } catch {
      return null;
    }
  }, [publicKey]);

  const bridgeContract = useMemo(() => {
    if (!publicKey) return null;
    const anchorWallet: Wallet = {
      publicKey,
      signTransaction,
      signAllTransactions,
      payer: publicKey
        ? ({ publicKey } as unknown as { publicKey: PublicKey })
        : undefined,
    } as unknown as Wallet;
    return new BridgeContract(connection, anchorWallet);
  }, [connection, publicKey, signTransaction, signAllTransactions]);

  useEffect(() => {
    if (!publicKey || userBalancePdaSet.size === 0) return;

    const pk = publicKey.toString();

    let programSubId: number | undefined;

    try {
      programSubId = connection.onLogs(
        BRIDGE_PROGRAM_ID,
        async logs => {
          try {
            const raw = logs.logs.join('\n');

            const isRelevantInstruction =
              raw.includes('Instruction: completeWithdrawErc20') ||
              raw.includes('Instruction: claimErc20') ||
              raw.includes('Instruction: withdrawErc20') ||
              raw.includes('Instruction: depositErc20');

            if (!isRelevantInstruction) return;

            const mentionsUserPda = Array.from(userBalancePdaSet).some(pda =>
              raw.includes(pda),
            );
            const mentionsRequesterPda =
              requesterPdaBase58 && raw.includes(requesterPdaBase58);

            if (!mentionsUserPda && !mentionsRequesterPda) {
              return;
            }

            const isCompletion =
              raw.includes('completeWithdrawErc20') ||
              raw.includes('claimErc20');
            const isInitiation =
              raw.includes('withdrawErc20') || raw.includes('depositErc20');

            const queriesToInvalidate: Array<{ queryKey: any }> = [];

            if (isCompletion) {
              queriesToInvalidate.push(
                { queryKey: queryKeys.solana.userBalances(pk) },
                { queryKey: queryKeys.solana.unclaimedBalances(pk) },
              );
            }

            if (isCompletion || isInitiation) {
              queriesToInvalidate.push(
                { queryKey: queryKeys.solana.incomingDeposits(pk) },
                { queryKey: queryKeys.solana.outgoingTransfers(pk) },
              );
            }

            if (queriesToInvalidate.length > 0) {
              await Promise.all(
                queriesToInvalidate.map(query =>
                  queryClient.invalidateQueries(query),
                ),
              );
            }
          } catch (error) {
            console.error('[BridgeAutoRefetch] Error processing logs:', error);
          }
        },
        'confirmed',
      );
    } catch (error) {
      console.warn(
        '[BridgeAutoRefetch] Failed to create log subscription:',
        error,
      );
    }

    const accountSubId: number | null = null;

    return () => {
      if (programSubId !== undefined) {
        try {
          connection.removeOnLogsListener(programSubId).catch(error => {});
        } catch {}
      }

      if (accountSubId !== null) {
        try {
          connection
            .removeAccountChangeListener(accountSubId)
            .catch(error => {});
        } catch {}
      }
    };
  }, [
    connection,
    publicKey,
    userBalancePdaSet,
    requesterPdaBase58,
    queryClient,
    bridgeContract,
  ]);
}
