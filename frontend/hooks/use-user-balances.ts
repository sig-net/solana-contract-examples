'use client';

import { useQuery } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';

import { queryKeys } from '@/lib/query-client';

import { useTokenBalanceService } from './use-token-balance-service';

export function useUserBalances() {
  const { publicKey } = useWallet();
  const tokenBalanceService = useTokenBalanceService();

  return useQuery({
    queryKey: publicKey
      ? queryKeys.solana.userBalances(publicKey.toString())
      : [],
    queryFn: () => {
      if (!publicKey) throw new Error('No public key available');
      if (!tokenBalanceService)
        throw new Error('Token balance service not available');
      return tokenBalanceService.fetchUserBalances(publicKey);
    },
    enabled: !!publicKey && !!tokenBalanceService,
    staleTime: 3 * 1000, // 3 seconds
    refetchInterval: 5 * 1000, // Refetch every 5 seconds
    refetchIntervalInBackground: true,
  });
}
