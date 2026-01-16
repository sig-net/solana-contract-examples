'use client';

import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-client';

import { useBridgeContract } from './use-bridge-contract';
import { useSolanaPublicKey } from './use-solana-public-key';

export function useDepositAddress() {
  const bridgeContract = useBridgeContract();
  const publicKey = useSolanaPublicKey();

  return useQuery({
    queryKey: publicKey
      ? queryKeys.solana.depositAddress(publicKey.toString())
      : [],
    queryFn: () => {
      if (!publicKey || !bridgeContract)
        throw new Error('No public key or bridge contract available');
      return bridgeContract.deriveDepositAddress(publicKey);
    },
    enabled: !!publicKey && !!bridgeContract,
  });
}
