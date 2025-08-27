'use client';

import { useQuery } from '@tanstack/react-query';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useMemo } from 'react';

import { queryKeys } from '@/lib/query-client';
import { BridgeContract } from '@/lib/contracts/bridge-contract';

import { useAnchorWallet } from './use-anchor-wallet';

export function useDepositAddress() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();

  const bridgeContract = useMemo(() => {
    if (!anchorWallet) return null;
    return new BridgeContract(connection, anchorWallet);
  }, [connection, anchorWallet]);

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
