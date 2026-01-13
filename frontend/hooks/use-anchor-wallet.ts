'use client';

import { useWallet } from '@solana/wallet-adapter-react';
import type { Wallet } from '@coral-xyz/anchor';

export function useAnchorWallet(): Wallet | null {
  const wallet = useWallet();

  if (!wallet.publicKey) {
    return null;
  }

  return {
    publicKey: wallet.publicKey,
    signTransaction: wallet.signTransaction,
    signAllTransactions: wallet.signAllTransactions,
    payer: { publicKey: wallet.publicKey },
  } as Wallet;
}
