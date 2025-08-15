'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';

import { queryKeys } from '@/lib/query-client';

import { useDepositService } from './use-deposit-service';

export function useDepositEvmMutation() {
  const { publicKey } = useWallet();
  const depositService = useDepositService();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      erc20Address,
      amount,
      decimals,
      onStatusChange,
    }: {
      erc20Address: string;
      amount: string;
      decimals: number;
      onStatusChange?: (status: {
        status: string;
        txHash?: string;
        note?: string;
        error?: string;
      }) => void;
    }) => {
      if (!publicKey) throw new Error('No public key available');
      return depositService.depositErc20(
        publicKey,
        erc20Address,
        amount,
        decimals,
        onStatusChange,
      );
    },
    onSuccess: () => {
      if (publicKey) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.solana.userBalances(publicKey.toString()),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.solana.unclaimedBalances(publicKey.toString()),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.solana.incomingDeposits(publicKey.toString()),
        });
      }
    },
    onError: error => {
      console.error('Deposit EVM mutation failed:', error);

      if (publicKey) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.solana.incomingDeposits(publicKey.toString()),
        });
      }
    },
  });
}
