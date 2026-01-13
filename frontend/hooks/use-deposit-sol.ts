'use client';

import { useWallet } from '@solana/wallet-adapter-react';

export function useDepositSol() {
  const { publicKey } = useWallet();

  return {
    depositAddress: publicKey?.toString() ?? '',
    canDeposit: !!publicKey,
  };
}
