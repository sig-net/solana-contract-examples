'use client';

import { useWallet } from '@solana/wallet-adapter-react';
import { useMemo } from 'react';
import { Wallet } from '@coral-xyz/anchor';

export function useAnchorWallet(): Wallet | null {
  const wallet = useWallet();

  return useMemo(() => {
    if (!wallet.publicKey) {
      return null;
    }

    const anchorWallet: Wallet = {
      publicKey: wallet.publicKey,
      signTransaction: wallet.signTransaction,
      signAllTransactions: wallet.signAllTransactions,
      payer: { publicKey: wallet.publicKey },
    } as Wallet;

    return anchorWallet;
  }, [wallet.publicKey, wallet.signTransaction, wallet.signAllTransactions]);
}
