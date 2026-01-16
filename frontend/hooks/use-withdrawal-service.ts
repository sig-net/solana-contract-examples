'use client';

import { WithdrawalService } from '@/lib/services/withdrawal-service';

import { useBridgeContract } from './use-bridge-contract';

export function useWithdrawalService() {
  const bridgeContract = useBridgeContract();

  if (!bridgeContract) {
    return null;
  }

  return new WithdrawalService(bridgeContract);
}
