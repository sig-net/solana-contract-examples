'use client';

import { useMemo } from 'react';

import { TokenBalanceService } from '@/lib/services/token-balance-service';
import { WithdrawalService } from '@/lib/services/withdrawal-service';

import { useBridgeContract } from './use-bridge-contract';

export function useWithdrawalService() {
  const bridgeContract = useBridgeContract();

  return useMemo(() => {
    if (!bridgeContract) {
      return null;
    }

    const tokenBalanceService = new TokenBalanceService(bridgeContract);
    const withdrawalService = new WithdrawalService(
      bridgeContract,
      tokenBalanceService,
    );

    return withdrawalService;
  }, [bridgeContract]);
}
