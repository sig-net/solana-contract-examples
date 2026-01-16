'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/connector/react';
import { PublicKey } from '@solana/web3.js';

import { queryKeys } from '@/lib/query-client';

import { useWithdrawalService } from './use-withdrawal-service';

export function useWithdrawSolMutation() {
  const { account, isConnected } = useWallet();
  const withdrawalService = useWithdrawalService();
  const queryClient = useQueryClient();

  const publicKey = isConnected && account ? new PublicKey(account) : null;

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
      onStatusChange?: (status: {
        status: string;
        txHash?: string;
        note?: string;
        error?: string;
      }) => void;
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
        queryClient.invalidateQueries({
          queryKey: queryKeys.solana.userBalances(account),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.solana.unclaimedBalances(account),
        });
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
