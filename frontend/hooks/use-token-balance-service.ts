'use client';

import { TokenBalanceService } from '@/lib/services/token-balance-service';

import { useDexContract } from './use-dex-contract';

export function useTokenBalanceService() {
  const dexContract = useDexContract();

  if (!dexContract) {
    return null;
  }

  return new TokenBalanceService(dexContract);
}
