'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/connector/react';
import { toast } from 'sonner';

import { queryKeys } from '@/lib/query-client';
import { DepositService, type DepositResult } from '@/lib/services/deposit-service';
import type { StatusCallback } from '@/lib/types/shared.types';
import { usePendingTransactions } from '@/providers/pending-transactions-context';

import { useSolanaPublicKey } from './use-solana-public-key';

const depositService = new DepositService();

export function useDepositEvmMutation() {
  const { account } = useWallet();
  const queryClient = useQueryClient();
  const publicKey = useSolanaPublicKey();
  const { addPendingTransaction } = usePendingTransactions();

  return useMutation({
    mutationFn: async ({
      erc20Address,
      amount,
      decimals,
      tokenSymbol,
      onStatusChange,
    }: {
      erc20Address: string;
      amount: string;
      decimals: number;
      tokenSymbol?: string;
      onStatusChange?: StatusCallback;
    }): Promise<DepositResult> => {
      if (!publicKey) throw new Error('No public key available');
      return depositService.depositErc20(
        publicKey,
        erc20Address,
        amount,
        decimals,
        tokenSymbol,
        onStatusChange,
      );
    },
    onSuccess: (result, variables) => {
      // Add to pending transactions for tracking
      if (account) {
        addPendingTransaction({
          id: result.trackingId,
          type: 'deposit',
          erc20Address: variables.erc20Address,
          userAddress: account,
          startedAt: Date.now(),
        });

        toast.info('Deposit initiated', {
          description: 'Monitoring for your deposit...',
        });

        queryClient.invalidateQueries({
          queryKey: queryKeys.solana.txList(account),
        });
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

      toast.error('Deposit failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });
}
