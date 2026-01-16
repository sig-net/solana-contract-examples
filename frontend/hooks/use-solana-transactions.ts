'use client';

import { useQuery } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';

import { useConnection } from '@/providers/connection-context';
import { queryKeys } from '@/lib/query-client';
import { getRPCManager } from '@/lib/utils/rpc-manager';
import { getAllNetworks } from '@/lib/constants/token-metadata';

import { useSolanaPublicKey } from './use-solana-public-key';

export interface SolanaWalletTransactionItem {
  id: string;
  signature: string;
  timestamp: number;
  direction: 'in' | 'out';
  symbol: string;
  decimals: number;
  amount: bigint;
  mint?: string;
}

const TRANSACTION_LIMIT = 5;

export function useSolanaTransactions(limit = TRANSACTION_LIMIT) {
  const { connection } = useConnection();
  const publicKey = useSolanaPublicKey();

  return useQuery({
    queryKey: publicKey
      ? [...queryKeys.solana.all, 'walletTransactions', publicKey.toString()]
      : [],
    enabled: !!publicKey,
    staleTime: 3 * 1000,
    gcTime: 30 * 60_000,
    refetchInterval: 5 * 1000,
    refetchIntervalInBackground: true,

    queryFn: async (): Promise<SolanaWalletTransactionItem[]> => {
      if (!publicKey) throw new Error('No public key available');

      const rpcManager = getRPCManager(connection);
      const userAddress = publicKey.toBase58();

      const tokens =
        getAllNetworks().find(n => n.chain === 'solana')?.tokens ?? [];

      if (tokens.length === 0) return [];

      const tokenMap = new Map(
        tokens.map(t => [
          t.address,
          { symbol: t.symbol, decimals: t.decimals },
        ]),
      );

      const ataSignatures = await Promise.all(
        tokens.map(async token => {
          try {
            const ata = await getAssociatedTokenAddress(
              new PublicKey(token.address),
              publicKey,
              true,
            );
            return await rpcManager.getSignaturesForAddress(ata, { limit: 10 });
          } catch {
            return [];
          }
        }),
      );

      const uniqueSignatures = Array.from(
        new Map(ataSignatures.flat().map(sig => [sig.signature, sig])).values(),
      )
        .sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0))
        .slice(0, limit);

      if (uniqueSignatures.length === 0) return [];

      const transactions = await Promise.all(
        uniqueSignatures.map(sig =>
          rpcManager.getTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          }),
        ),
      );

      return transactions
        .map((tx, i) => {
          if (!tx?.meta) return null;

          const sigInfo = uniqueSignatures[i];
          if (!sigInfo) return null;
          const signature = sigInfo.signature;
          const timestamp = sigInfo.blockTime || Date.now() / 1000;

          const transfers: SolanaWalletTransactionItem[] = [];

          const balanceChanges = new Map<
            string,
            { pre: bigint; post: bigint; decimals: number }
          >();

          tx.meta.preTokenBalances?.forEach(balance => {
            if (balance.owner === userAddress) {
              const current = balanceChanges.get(balance.mint) ?? {
                pre: BigInt(0),
                post: BigInt(0),
                decimals: 6,
              };
              current.pre = BigInt(balance.uiTokenAmount?.amount ?? '0');
              current.decimals = balance.uiTokenAmount?.decimals ?? 6;
              balanceChanges.set(balance.mint, current);
            }
          });

          tx.meta.postTokenBalances?.forEach(balance => {
            if (balance.owner === userAddress) {
              const current = balanceChanges.get(balance.mint) ?? {
                pre: BigInt(0),
                post: BigInt(0),
                decimals: 6,
              };
              current.post = BigInt(balance.uiTokenAmount?.amount ?? '0');
              current.decimals = balance.uiTokenAmount?.decimals ?? 6;
              balanceChanges.set(balance.mint, current);
            }
          });

          balanceChanges.forEach((change, mint) => {
            const delta = change.post - change.pre;
            if (delta === BigInt(0)) return;

            const tokenInfo = tokenMap.get(mint);

            transfers.push({
              id: `${signature}-${mint}`,
              signature,
              timestamp: Math.floor(timestamp),
              direction: delta > BigInt(0) ? 'in' : 'out',
              symbol: tokenInfo?.symbol ?? 'SPL',
              decimals: tokenInfo?.decimals ?? change.decimals,
              amount: delta > BigInt(0) ? delta : -delta,
              mint,
            });
          });

          return transfers;
        })
        .flat()
        .filter((item): item is SolanaWalletTransactionItem => item !== null);
    },
  });
}
