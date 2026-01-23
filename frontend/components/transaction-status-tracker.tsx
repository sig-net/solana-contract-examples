'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useWallet } from '@solana/connector/react';

import {
  usePendingTransactions,
  type PendingTransaction,
} from '@/providers/pending-transactions-context';
import { useTxStatus, getStatusLabel } from '@/hooks';
import { recoverTransaction } from '@/lib/services/relayer-service';

function TransactionToast({ tx }: { tx: PendingTransaction }) {
  const { account } = useWallet();
  const { data: status, refetch } = useTxStatus(tx.id);
  const { removePendingTransaction } = usePendingTransactions();
  const previousStatusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!status) return;

    const currentStatus = status.status;
    const previousStatus = previousStatusRef.current;

    // Only show toast if status changed
    if (previousStatus !== currentStatus) {
      previousStatusRef.current = currentStatus;

      const label = getStatusLabel(currentStatus);
      const txType = tx.type === 'deposit' ? 'Deposit' : 'Withdrawal';

      // Remove from pending context when on-chain data exists to avoid duplicates
      // For deposits: solana_pending means Solana tx landed, appears in incomingTransfers
      // For withdrawals: signature_pending means processing started
      const hasOnChainData =
        currentStatus === 'solana_pending' ||
        currentStatus === 'signature_pending' ||
        currentStatus === 'ethereum_pending' ||
        currentStatus === 'completing' ||
        currentStatus === 'completed';

      if (hasOnChainData) {
        removePendingTransaction(tx.id);
      }

      if (currentStatus === 'completed') {
        toast.success(`${txType} completed!`, {
          description: status.ethereumTxHash
            ? `ETH Tx: ${status.ethereumTxHash.slice(0, 10)}...`
            : undefined,
        });
      } else if (currentStatus === 'failed') {
        toast.error(`${txType} failed`, {
          description: status.error || 'Unknown error',
          action: account
            ? {
                label: 'Retry',
                onClick: async () => {
                  try {
                    await recoverTransaction({
                      requestId: tx.id,
                      type: tx.type,
                      userAddress: account,
                      erc20Address: tx.erc20Address,
                    });
                    toast.info('Recovery initiated', {
                      description: 'The transaction will be retried',
                    });
                    refetch();
                  } catch (error) {
                    toast.error('Recovery failed', {
                      description:
                        error instanceof Error
                          ? error.message
                          : 'Unknown error',
                    });
                  }
                },
              }
            : undefined,
        });
        // Keep in pending for retry possibility
      } else if (previousStatus && previousStatus !== 'pending') {
        // Show progress update for non-initial states
        toast.info(`${txType}: ${label}`, {
          id: `tx-progress-${tx.id}`,
        });
      }
    }
  }, [status, tx, account, removePendingTransaction, refetch]);

  return null;
}

export function TransactionStatusTracker() {
  const { pendingTransactions } = usePendingTransactions();

  return (
    <>
      {pendingTransactions.map(tx => (
        <TransactionToast key={tx.id} tx={tx} />
      ))}
    </>
  );
}
