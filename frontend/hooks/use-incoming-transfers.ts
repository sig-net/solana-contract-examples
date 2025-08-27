'use client';

import { useQuery } from '@tanstack/react-query';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import type { Wallet } from '@coral-xyz/anchor';

import { queryKeys } from '@/lib/query-client';
import { BridgeContract } from '@/lib/contracts/bridge-contract';

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
  const wallet = useWallet();
  const { publicKey } = wallet;

  const query = useQuery({
    queryKey: publicKey
      ? queryKeys.solana.incomingDeposits(publicKey.toString())
      : [],
    queryFn: async (): Promise<TransferEvent[]> => {
      if (!publicKey) throw new Error('No public key available');

      const anchorWallet: Wallet = {
        publicKey,
        signTransaction: wallet.signTransaction,
        signAllTransactions: wallet.signAllTransactions,
        payer: publicKey ? { publicKey } : undefined,
      } as unknown as Wallet;

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
    enabled: !!publicKey,
    staleTime: 3 * 1000, // 3 seconds
    refetchInterval: 5 * 1000, // Refetch every 5 seconds
    refetchIntervalInBackground: true,
  });

  return query;
}
