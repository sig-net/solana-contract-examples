'use client';

import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-client';

import { useDexContract } from './use-dex-contract';
import { useSolanaPublicKey } from './use-solana-public-key';

interface TransferEvent {
  requestId: string;
  tokenAddress: string;
  value: bigint;
  timestamp?: number;
  status: 'pending' | 'completed';
  transactionHash?: string;
}

export function useIncomingTransfers() {
  const dexContract = useDexContract();
  const publicKey = useSolanaPublicKey();

  return useQuery({
    queryKey: publicKey
      ? queryKeys.solana.incomingDeposits(publicKey.toString())
      : [],
    queryFn: async (): Promise<TransferEvent[]> => {
      if (!publicKey || !dexContract)
        throw new Error('No public key or dex contract available');

      const deposits = await dexContract.fetchAllUserDeposits(publicKey);
      return deposits.map(d => ({
        requestId: d.requestId,
        tokenAddress: d.erc20Address,
        value: BigInt(d.amount),
        timestamp: d.timestamp,
        status: d.status,
        transactionHash: d.ethereumTxHash,
      }));
    },
    enabled: !!publicKey && !!dexContract,
    staleTime: 3 * 1000,
    refetchInterval: 5 * 1000,
    refetchIntervalInBackground: true,
  });
}
