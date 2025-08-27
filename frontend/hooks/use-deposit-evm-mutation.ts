'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useMemo } from 'react';

import { queryKeys } from '@/lib/query-client';
import { BridgeContract } from '@/lib/contracts/bridge-contract';
import { DepositService } from '@/lib/services/deposit-service';

import { useAnchorWallet } from './use-anchor-wallet';

export function useDepositEvmMutation() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();
  const queryClient = useQueryClient();

  const depositService = useMemo(() => {
    if (!anchorWallet) return null;
    const bridgeContract = new BridgeContract(connection, anchorWallet);
    return new DepositService(bridgeContract);
  }, [connection, anchorWallet]);

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
      if (!depositService) throw new Error('Deposit service not available');
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
