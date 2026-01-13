'use client';

import { useQuery } from '@tanstack/react-query';
import { useWallet } from '@solana/connector/react';
import { PublicKey } from '@solana/web3.js';

import { queryKeys } from '@/lib/query-client';

import { useBridgeContract } from './use-bridge-contract';

export function useDepositAddress() {
  const { account, isConnected } = useWallet();
  const bridgeContract = useBridgeContract();

  const publicKey = isConnected && account ? new PublicKey(account) : null;

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
