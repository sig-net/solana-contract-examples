'use client';

import { useWallet } from '@solana/connector/react';

export function useDepositSol() {
  const { account, isConnected } = useWallet();

  return {
    depositAddress: account ?? '',
    canDeposit: isConnected && !!account,
  };
}
