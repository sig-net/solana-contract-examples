'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/connector/react';

import { queryKeys, invalidateWithdrawalQueries } from '@/lib/query-client';
import type { StatusCallback } from '@/lib/types/shared.types';

import { useWithdrawalService } from './use-withdrawal-service';
import { useSolanaPublicKey } from './use-solana-public-key';

export function useWithdrawEvmMutation() {
  const { account } = useWallet();
  const withdrawalService = useWithdrawalService();
  const queryClient = useQueryClient();
  const publicKey = useSolanaPublicKey();

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
      onStatusChange?: StatusCallback;
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
        invalidateWithdrawalQueries(queryClient, account);
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
