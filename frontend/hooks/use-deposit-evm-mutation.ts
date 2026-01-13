'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/connector/react';
import { PublicKey } from '@solana/web3.js';

import { queryKeys } from '@/lib/query-client';
import { DepositService } from '@/lib/services/deposit-service';

const depositService = new DepositService();

export function useDepositEvmMutation() {
  const { account, isConnected } = useWallet();
  const queryClient = useQueryClient();

  const publicKey = isConnected && account ? new PublicKey(account) : null;

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
      if (account) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.solana.userBalances(account),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.solana.unclaimedBalances(account),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.solana.incomingDeposits(account),
        });
      }
    },
    onError: error => {
      console.error('Deposit EVM mutation failed:', error);

      if (account) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.solana.incomingDeposits(account),
        });
      }
    },
  });
}
