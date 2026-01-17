'use client';

import { WithdrawalService } from '@/lib/services/withdrawal-service';

import { useDexContract } from './use-dex-contract';

export function useWithdrawalService() {
  const dexContract = useDexContract();

  if (!dexContract) {
    return null;
  }

  return new WithdrawalService(dexContract);
}
