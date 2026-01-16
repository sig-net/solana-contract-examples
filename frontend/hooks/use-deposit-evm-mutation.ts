'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/connector/react';

import { queryKeys, invalidateDepositQueries } from '@/lib/query-client';
import { DepositService } from '@/lib/services/deposit-service';

import { useSolanaPublicKey } from './use-solana-public-key';

const depositService = new DepositService();

export function useDepositEvmMutation() {
  const { account } = useWallet();
  const queryClient = useQueryClient();
  const publicKey = useSolanaPublicKey();

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
        invalidateDepositQueries(queryClient, account);
      }
    },
    onError: (error, variables) => {
      console.error('Deposit EVM mutation failed:', error);
      if (variables.onStatusChange) {
        variables.onStatusChange({
          status: 'failed',
          error: error instanceof Error ? error.message : 'Deposit failed',
        });
      }

      if (account) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.solana.incomingDeposits(account),
        });
      }
    },
  });
}
