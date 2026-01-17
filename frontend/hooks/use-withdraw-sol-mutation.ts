'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/connector/react';

import { queryKeys, invalidateBalanceQueries } from '@/lib/query-client';
import type { StatusCallback } from '@/lib/types/shared.types';

import { useWithdrawalService } from './use-withdrawal-service';
import { useSolanaPublicKey } from './use-solana-public-key';

export function useWithdrawSolMutation() {
  const { account } = useWallet();
  const withdrawalService = useWithdrawalService();
  const queryClient = useQueryClient();
  const publicKey = useSolanaPublicKey();

  return useMutation({
    mutationFn: async ({
      mintAddress,
      amount,
      recipientAddress,
      decimals,
      onStatusChange,
    }: {
      mintAddress: string;
      amount: string;
      recipientAddress: string;
      decimals?: number;
      onStatusChange?: StatusCallback;
    }) => {
      if (!publicKey) throw new Error('No public key available');
      if (!withdrawalService)
        throw new Error('Withdrawal service not available');
      return withdrawalService.withdrawSol(
        publicKey,
        mintAddress,
        amount,
        recipientAddress,
        decimals ?? 6,
        onStatusChange,
      );
    },
    onSuccess: () => {
      if (account) {
        invalidateBalanceQueries(queryClient, account);
        queryClient.invalidateQueries({
          queryKey: [...queryKeys.solana.all, 'walletTransactions', account],
        });
      }
    },
    onError: (error, variables) => {
      console.error('Withdraw SOL mutation failed:', error);
      if (variables.onStatusChange) {
        variables.onStatusChange({
          status: 'failed',
          error: error instanceof Error ? error.message : 'Withdrawal failed',
        });
      }

      if (account) {
        queryClient.invalidateQueries({
          queryKey: [...queryKeys.solana.all, 'walletTransactions', account],
        });
      }
    },
  });
}
