'use client';

import { useMemo } from 'react';

import { TokenBalanceService } from '@/lib/services/token-balance-service';

import { useBridgeContract } from './use-bridge-contract';

export function useTokenBalanceService() {
  const bridgeContract = useBridgeContract();

  return useMemo(() => {
    if (!bridgeContract) {
      return null;
    }

    return new TokenBalanceService(bridgeContract);
  }, [bridgeContract]);
}
