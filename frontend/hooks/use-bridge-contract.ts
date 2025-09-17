'use client';

import { useConnection } from '@solana/wallet-adapter-react';
import { useMemo } from 'react';

import { BridgeContract } from '@/lib/contracts/bridge-contract';

import { useAnchorWallet } from './use-anchor-wallet';

export function useBridgeContract() {
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();

  return useMemo(() => {
    if (!anchorWallet) return null;
    return new BridgeContract(connection, anchorWallet);
  }, [connection, anchorWallet]);
}
