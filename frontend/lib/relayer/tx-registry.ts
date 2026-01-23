import { Redis } from '@upstash/redis';
import { getFullEnv } from '@/lib/config/env.config';

function getRedisClient() {
  const env = getFullEnv();
  return new Redis({
    url: env.REDIS_URL,
    token: env.REDIS_TOKEN,
  });
}

export type TxStatus =
  | 'pending'
  | 'balance_polling'
  | 'solana_pending'
  | 'signature_pending'
  | 'ethereum_pending'
  | 'completing'
  | 'completed'
  | 'failed';

export interface TxEntry {
  id: string;
  requestId?: string;
  type: 'deposit' | 'withdrawal';
  status: TxStatus;
  userAddress: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  ethereumTxHash?: string;
  solanaTxHash?: string;
}

const TX_PREFIX = 'tx:';
const USER_TX_PREFIX = 'user-txs:';
const TX_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export async function registerTx(
  id: string,
  type: TxEntry['type'],
  userAddress: string,
): Promise<void> {
  const redis = getRedisClient();
  const entry: TxEntry = {
    id,
    type,
    userAddress,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await redis.set(`${TX_PREFIX}${id}`, entry, { ex: TX_TTL_SECONDS });
  // Track transaction ID in user's list
  await redis.sadd(`${USER_TX_PREFIX}${userAddress}`, id);
  await redis.expire(`${USER_TX_PREFIX}${userAddress}`, TX_TTL_SECONDS);
}

export async function updateTxStatus(
  id: string,
  status: TxStatus,
  metadata?: Partial<
    Pick<TxEntry, 'error' | 'ethereumTxHash' | 'solanaTxHash' | 'requestId'>
  >,
): Promise<void> {
  const redis = getRedisClient();
  const entry = await redis.get<TxEntry>(`${TX_PREFIX}${id}`);
  if (!entry) return;

  const updated: TxEntry = {
    ...entry,
    ...metadata,
    status,
    updatedAt: Date.now(),
  };
  await redis.set(`${TX_PREFIX}${id}`, updated, { ex: TX_TTL_SECONDS });

  // Always update requestId index if we have one (either new or existing)
  const requestId = metadata?.requestId ?? entry.requestId;
  if (requestId && requestId !== id) {
    await redis.set(`${TX_PREFIX}${requestId}`, updated, {
      ex: TX_TTL_SECONDS,
    });
  }
}

export async function getTxStatus(id: string): Promise<TxEntry | null> {
  const redis = getRedisClient();
  return redis.get<TxEntry>(`${TX_PREFIX}${id}`);
}

export async function getUserTransactions(
  userAddress: string,
): Promise<TxEntry[]> {
  const redis = getRedisClient();
  const txIds = await redis.smembers(`${USER_TX_PREFIX}${userAddress}`);
  if (!txIds || txIds.length === 0) return [];

  const transactions = await Promise.all(
    txIds.map(id => redis.get<TxEntry>(`${TX_PREFIX}${id}`)),
  );

  return transactions
    .filter((tx): tx is TxEntry => tx !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}
