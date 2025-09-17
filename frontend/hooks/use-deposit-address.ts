'use client';

import { useQuery } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';

import { queryKeys } from '@/lib/query-client';

import { useBridgeContract } from './use-bridge-contract';

export function useDepositAddress() {
  const { publicKey } = useWallet();
  const bridgeContract = useBridgeContract();

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
