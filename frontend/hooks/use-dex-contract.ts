'use client';

import { useConnection } from '@/providers/connection-context';
import { DexContract } from '@/lib/contracts/dex-contract';

import { useAnchorWallet } from './use-anchor-wallet';

export function useDexContract() {
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();

  if (!anchorWallet) return null;
  return new DexContract(connection, anchorWallet);
}
