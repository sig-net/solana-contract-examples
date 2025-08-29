import type { EvmTransactionRequestNotifyWithdrawal } from '@/lib/types/shared.types';
import { getClientEnv } from '@/lib/config/env.config';

export class RelayerService {
  async notifyDeposit({
    userAddress,
    erc20Address,
    ethereumAddress,
  }: {
    userAddress: string;
    erc20Address: string;
    ethereumAddress: string;
  }): Promise<void> {
    const env = getClientEnv();
    const url = env.NEXT_PUBLIC_NOTIFY_DEPOSIT_URL;
    if (!url) {
      throw new Error('NEXT_PUBLIC_NOTIFY_DEPOSIT_URL is not set');
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAddress, erc20Address, ethereumAddress }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Relayer notifyDeposit failed: ${res.status} ${res.statusText} - ${text}`,
      );
    }
  }

  async notifyWithdrawal({
    requestId,
    erc20Address,
    transactionParams,
  }: {
    requestId: string;
    erc20Address: string;
    transactionParams?: EvmTransactionRequestNotifyWithdrawal;
  }): Promise<void> {
    const env = getClientEnv();
    const url = env.NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL;
    if (!url) {
      throw new Error('NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL is not set');
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        erc20Address,
        transactionParams,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Relayer notification failed: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    return response.json();
  }
}
