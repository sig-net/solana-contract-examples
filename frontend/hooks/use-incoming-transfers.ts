'use client';

import { useQuery } from '@tanstack/react-query';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';

import { queryKeys } from '@/lib/query-client';
import { BridgeContract } from '@/lib/contracts/bridge-contract';

import { useAnchorWallet } from './use-anchor-wallet';

export interface TransferEvent {
  requestId: string;
  tokenAddress: string;
  value: bigint;
  timestamp?: number;
  status: 'pending' | 'completed';
  transactionHash?: string;
}

export function useIncomingTransfers() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();

  const query = useQuery({
    queryKey: publicKey
      ? queryKeys.solana.incomingDeposits(publicKey.toString())
      : [],
    queryFn: async (): Promise<TransferEvent[]> => {
      if (!publicKey || !anchorWallet)
        throw new Error('No public key or anchor wallet available');

      const bridgeContract = new BridgeContract(connection, anchorWallet);

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
    enabled: !!publicKey && !!anchorWallet,
    staleTime: 3 * 1000, // 3 seconds
    refetchInterval: 5 * 1000, // Refetch every 5 seconds
    refetchIntervalInBackground: true,
  });

  return query;
}
