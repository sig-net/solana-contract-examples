'use client';

import { useQuery } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';

import { queryKeys } from '@/lib/query-client';

import { useBridgeContract } from './use-bridge-contract';

export interface TransferEvent {
  requestId: string;
  tokenAddress: string;
  value: bigint;
  timestamp?: number;
  status: 'pending' | 'completed';
  transactionHash?: string;
}

export function useIncomingTransfers() {
  const { publicKey } = useWallet();
  const bridgeContract = useBridgeContract();

  const query = useQuery({
    queryKey: publicKey
      ? queryKeys.solana.incomingDeposits(publicKey.toString())
      : [],
    queryFn: async (): Promise<TransferEvent[]> => {
      if (!publicKey || !bridgeContract)
        throw new Error('No public key or bridge contract available');

      const deposits = await bridgeContract.fetchAllUserDeposits(publicKey);
      return deposits.map(d => ({
        requestId: d.requestId,
        tokenAddress: d.erc20Address,
        value: BigInt(d.amount),
        timestamp: d.timestamp,
        status: d.status,
        transactionHash: d.ethereumTxHash,
      }));
    },
    enabled: !!publicKey && !!bridgeContract,
    staleTime: 3 * 1000, // 3 seconds
    refetchInterval: 5 * 1000, // Refetch every 5 seconds
    refetchIntervalInBackground: true,
  });

  return query;
}
