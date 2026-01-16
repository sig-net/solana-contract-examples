'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/connector/react';
import { PublicKey } from '@solana/web3.js';

import { queryKeys } from '@/lib/query-client';

import { useWithdrawalService } from './use-withdrawal-service';

export function useWithdrawEvmMutation() {
  const { account, isConnected } = useWallet();
  const withdrawalService = useWithdrawalService();
  const queryClient = useQueryClient();

  const publicKey = isConnected && account ? new PublicKey(account) : null;

  return useMutation({
    mutationFn: async ({
      erc20Address,
      amount,
      recipientAddress,
      onStatusChange,
    }: {
      erc20Address: string;
      amount: string;
      recipientAddress: string;
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
      return withdrawalService.withdrawEvm(
        publicKey,
        erc20Address,
        amount,
        recipientAddress,
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
          queryKey: queryKeys.solana.outgoingTransfers(account),
        });
      }
    },
    onError: (error, variables) => {
      console.error('Withdraw EVM mutation failed:', error);
      if (variables.onStatusChange) {
        variables.onStatusChange({
          status: 'failed',
          error: error instanceof Error ? error.message : 'Withdrawal failed',
        });
      }

      if (account) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.solana.outgoingTransfers(account),
        });
      }
    },
  });
}
