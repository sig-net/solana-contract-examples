'use client';

import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-client';

import { useTokenBalanceService } from './use-token-balance-service';
import { useSolanaPublicKey } from './use-solana-public-key';

export function useUserBalances() {
  const tokenBalanceService = useTokenBalanceService();
  const publicKey = useSolanaPublicKey();

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
    staleTime: 3 * 1000,
    refetchInterval: 5 * 1000,
    refetchIntervalInBackground: true,
  });
}
