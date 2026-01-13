'use client';

import { useConnection } from '@/providers/connection-context';
import { BridgeContract } from '@/lib/contracts/bridge-contract';

import { useAnchorWallet } from './use-anchor-wallet';

export function useBridgeContract() {
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();

  if (!anchorWallet) return null;
  return new BridgeContract(connection, anchorWallet);
}
