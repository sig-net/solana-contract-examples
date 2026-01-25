import type { EvmTransactionRequestNotifyWithdrawal } from '@/lib/types/shared.types';
import { getClientEnv } from '@/lib/config/env.config';

export interface NotifyDepositResponse {
  accepted: boolean;
  trackingId: string;
}

export async function notifyDeposit({
  userAddress,
  erc20Address,
  ethereumAddress,
  tokenDecimals,
  tokenSymbol,
}: {
  userAddress: string;
  erc20Address: string;
  ethereumAddress: string;
  tokenDecimals?: number;
  tokenSymbol?: string;
}): Promise<NotifyDepositResponse> {
  const env = getClientEnv();
  const url = env.NEXT_PUBLIC_NOTIFY_DEPOSIT_URL;
  if (!url) {
    throw new Error('NEXT_PUBLIC_NOTIFY_DEPOSIT_URL is not set');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userAddress,
      erc20Address,
      ethereumAddress,
      tokenDecimals,
      tokenSymbol,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Relayer notifyDeposit failed: ${res.status} ${res.statusText} - ${text}`,
    );
  }
  return res.json();
}

export async function notifyWithdrawal({
  requestId,
  erc20Address,
  userAddress,
  recipientAddress,
  transactionParams,
  tokenAmount,
  tokenDecimals,
  tokenSymbol,
}: {
  requestId: string;
  erc20Address: string;
  userAddress: string;
  recipientAddress: string;
  transactionParams?: EvmTransactionRequestNotifyWithdrawal;
  tokenAmount?: string;
  tokenDecimals?: number;
  tokenSymbol?: string;
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
      userAddress,
      recipientAddress,
      transactionParams,
      tokenAmount,
      tokenDecimals,
      tokenSymbol,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Relayer notification failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }
}

export async function recoverTransaction({
  requestId,
  type,
  userAddress,
  erc20Address,
}: {
  requestId: string;
  type: 'deposit' | 'withdrawal';
  userAddress: string;
  erc20Address?: string;
}): Promise<{ accepted: boolean; message: string }> {
  const res = await fetch('/api/recover-pending', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, type, userAddress, erc20Address }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Recovery failed: ${res.status} - ${text}`);
  }
  return res.json();
}
