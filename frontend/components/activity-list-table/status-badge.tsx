import { cn } from '@/lib/utils';
import { useTxStatus } from '@/hooks/use-tx-status';
import type { TxStatus } from '@/lib/relayer/tx-registry';

interface StatusBadgeProps {
  status: 'pending' | 'completed' | 'failed';
  trackingId?: string;
}

function mapTxStatusToDisplayStatus(
  txStatus: TxStatus | undefined,
  fallbackStatus: StatusBadgeProps['status'],
): StatusBadgeProps['status'] {
  if (!txStatus) return fallbackStatus;

  switch (txStatus) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

export function StatusBadge({ status, trackingId }: StatusBadgeProps) {
  // Only poll for non-terminal statuses
  const shouldPoll = status !== 'completed' && status !== 'failed';
  const { data: txStatus } = useTxStatus(shouldPoll ? (trackingId ?? null) : null);

  // Use real-time status if available - simplified labels
  const displayStatus = mapTxStatusToDisplayStatus(txStatus?.status, status);
  const displayLabel =
    displayStatus === 'completed'
      ? 'Completed'
      : displayStatus === 'failed'
        ? 'Failed'
        : 'Pending';

  const variants = {
    pending: 'bg-colors-pastels-polar-100 border-colors-dark-neutral-50',
    completed: 'bg-colors-pastels-polar-100 border-colors-dark-neutral-50',
    failed: 'bg-red-50 border-red-200',
  } as const;

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5',
        variants[displayStatus],
      )}
    >
      <div
        className={cn(
          'h-2 w-2 rounded-full',
          displayStatus === 'failed'
            ? 'bg-red-500'
            : displayStatus === 'pending'
              ? 'animate-pulse bg-blue-500'
              : 'bg-success-500',
        )}
      />
      <span className='text-colors-dark-neutral-500 text-xs font-medium'>
        {displayLabel}
      </span>
    </div>
  );
}
