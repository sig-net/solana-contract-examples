'use client';

import { useConnection } from '@solana/wallet-adapter-react';
import { useMemo } from 'react';

import { BridgeContract } from '@/lib/contracts/bridge-contract';
import { TokenBalanceService } from '@/lib/services/token-balance-service';
import { WithdrawalService } from '@/lib/services/withdrawal-service';

import { useAnchorWallet } from './use-anchor-wallet';

export function useWithdrawalService() {
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();

  return useMemo(() => {
    if (!anchorWallet) {
      return null;
    }

    const bridgeContract = new BridgeContract(connection, anchorWallet);
    const tokenBalanceService = new TokenBalanceService(bridgeContract);
    const withdrawalService = new WithdrawalService(
      bridgeContract,
      tokenBalanceService,
    );

    return withdrawalService;
  }, [connection, anchorWallet]);
}
