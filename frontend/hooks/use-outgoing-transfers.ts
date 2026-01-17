'use client';

import { useQuery } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';

import { queryKeys } from '@/lib/query-client';
import { WithdrawalService } from '@/lib/services/withdrawal-service';
import { VAULT_ETHEREUM_ADDRESS } from '@/lib/constants/addresses';

import { useWithdrawalService } from './use-withdrawal-service';
import { useSolanaPublicKey } from './use-solana-public-key';

interface OutgoingTransfer {
  requestId: string;
  transactionHash?: string;
  blockNumber?: bigint;
  logIndex: number;
  from: string;
  to: string;
  value: bigint;
  tokenAddress: string;
  recipient: string;
  timestamp?: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

interface WithdrawalRequest {
  requestId: string;
  erc20Address: string;
  amount: string;
  recipient: string;
  timestamp: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  ethereumTxHash?: string;
}

async function fetchUserWithdrawals(
  publicKey: PublicKey,
  withdrawalService: WithdrawalService,
): Promise<WithdrawalRequest[]> {
  try {
    const allWithdrawals =
      await withdrawalService.fetchAllUserWithdrawals(publicKey);

    return allWithdrawals.map(withdrawal => ({
      requestId: withdrawal.requestId,
      erc20Address: withdrawal.erc20Address,
      amount: withdrawal.amount,
      recipient: withdrawal.recipient,
      timestamp: withdrawal.timestamp,
      status: withdrawal.status,
      ethereumTxHash: withdrawal.ethereumTxHash,
    }));
  } catch (error) {
    console.error('Error fetching user withdrawals:', error);
    return [];
  }
}

export function useOutgoingTransfers() {
  const withdrawalService = useWithdrawalService();
  const publicKey = useSolanaPublicKey();

  return useQuery({
    queryKey: publicKey
      ? queryKeys.solana.outgoingTransfers(publicKey.toString())
      : [],
    queryFn: async (): Promise<OutgoingTransfer[]> => {
      if (!publicKey) throw new Error('No public key available');
      if (!withdrawalService)
        throw new Error('Withdrawal service not available');

      const withdrawalRequests = await fetchUserWithdrawals(
        publicKey,
        withdrawalService,
      );

      return withdrawalRequests.map(
        (request): OutgoingTransfer => ({
          requestId: request.requestId,
          transactionHash: request.ethereumTxHash,
          blockNumber: undefined,
          logIndex: 0,
          from: VAULT_ETHEREUM_ADDRESS,
          to: request.recipient,
          value: BigInt(request.amount),
          tokenAddress: request.erc20Address,
          recipient: request.recipient,
          timestamp: request.timestamp,
          status: request.status,
        }),
      );
    },
    enabled: !!publicKey && !!withdrawalService,

    staleTime: 3 * 1000,
    gcTime: 15 * 60 * 1000,
    refetchInterval: 5 * 1000,
    refetchIntervalInBackground: true,
    retry: 2,
    retryDelay: 1500,
  });
}
