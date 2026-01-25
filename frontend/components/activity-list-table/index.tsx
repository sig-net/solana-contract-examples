import { useWallet } from '@solana/connector/react';
import { useState } from 'react';
import { ExternalLink } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useTxList } from '@/hooks/use-tx-list';
import { formatTokenBalanceSync } from '@/lib/utils/balance-formatter';
import { formatActivityDate } from '@/lib/utils/date-formatting';
import {
  getTransactionExplorerUrl,
  getSolanaExplorerUrl,
} from '@/lib/utils/network-utils';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { useSolanaTransactions } from '@/hooks/use-solana-transactions';
import type { TxEntry, TxStatus } from '@/lib/relayer/tx-registry';

import { DetailsCell } from './details-cell';
import { StatusBadge } from './status-badge';
import { TransactionDetailsDialog } from './transaction-details-dialog';

export interface ActivityTransaction {
  id: string;
  type: 'Send' | 'Swap' | 'Deposit' | 'Withdraw';
  fromToken?: {
    symbol: string;
    chain: string;
    amount: string;
    usdValue: string;
  };
  toToken?: {
    symbol: string;
    chain: string;
    amount: string;
    usdValue: string;
  };
  address?: string;
  timestamp: string;
  timestampRaw?: number;
  status: 'pending' | 'completed' | 'failed';
  transactionHash?: string;
  explorerUrl?: string;
}

interface ActivityListTableProps {
  className?: string;
}

function mapTxStatus(status: TxStatus): 'pending' | 'completed' | 'failed' {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'pending';
}

function buildTransactionsFromRedis(
  txList: TxEntry[],
): ActivityTransaction[] {
  return txList.map(tx => {
    const tokenSymbol = tx.tokenSymbol ?? 'ERC20';
    const formattedAmount =
      tx.tokenAmount && tx.tokenDecimals !== undefined
        ? formatTokenBalanceSync(tx.tokenAmount, tx.tokenDecimals, tokenSymbol, {
            showSymbol: true,
          })
        : tokenSymbol;

    return {
      id: tx.id,
      type: tx.type === 'deposit' ? 'Deposit' : 'Withdraw',
      fromToken: {
        symbol: tx.type === 'deposit' ? 'WALLET' : tokenSymbol,
        chain: 'ethereum',
        amount: tx.type === 'deposit' ? (tx.ethereumAddress ?? '') : formattedAmount,
        usdValue: '',
      },
      toToken: {
        symbol: tx.type === 'deposit' ? tokenSymbol : 'WALLET',
        chain: 'ethereum',
        amount: tx.type === 'deposit' ? formattedAmount : (tx.ethereumAddress ?? ''),
        usdValue: '',
      },
      address: tx.ethereumAddress,
      timestamp: formatActivityDate(tx.createdAt),
      timestampRaw: tx.createdAt,
      status: mapTxStatus(tx.status),
      transactionHash: tx.ethereumTxHash,
      explorerUrl: tx.ethereumTxHash
        ? getTransactionExplorerUrl(tx.ethereumTxHash)
        : undefined,
    };
  });
}

function buildSolanaTransactions(
  solanaTxs: ReturnType<typeof useSolanaTransactions>['data'],
  account: string | null,
): ActivityTransaction[] {
  if (!solanaTxs || solanaTxs.length === 0) return [];

  const solanaAddress = account ?? '';
  return solanaTxs.map(tx => {
    const formattedAmount = formatTokenBalanceSync(
      tx.amount,
      tx.decimals,
      tx.symbol,
      { showSymbol: true },
    );

    const isIncoming = tx.direction === 'in';

    return {
      id: `${tx.signature}-${tx.mint ?? 'SOL'}`,
      type: (isIncoming ? 'Deposit' : 'Withdraw') as ActivityTransaction['type'],
      fromToken: isIncoming
        ? {
            symbol: 'WALLET',
            chain: 'solana',
            amount: solanaAddress,
            usdValue: '',
          }
        : {
            symbol: tx.symbol,
            chain: 'solana',
            amount: formattedAmount,
            usdValue: '$0.00',
          },
      toToken: isIncoming
        ? {
            symbol: tx.symbol,
            chain: 'solana',
            amount: formattedAmount,
            usdValue: '$0.00',
          }
        : {
            symbol: 'WALLET',
            chain: 'solana',
            amount: solanaAddress,
            usdValue: '',
          },
      address: solanaAddress,
      timestamp: formatActivityDate(tx.timestamp),
      timestampRaw: tx.timestamp,
      status: 'completed',
      transactionHash: tx.signature,
      explorerUrl: getSolanaExplorerUrl(tx.signature),
    };
  });
}

export function ActivityListTable({ className }: ActivityListTableProps) {
  const { isConnected, account } = useWallet();
  const [selectedTransaction, setSelectedTransaction] =
    useState<ActivityTransaction | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: txList, isLoading: isLoadingTxList } = useTxList();

  const {
    data: solanaTxs,
    isLoading: isLoadingSolanaTxs,
  } = useSolanaTransactions(25);

  const isLoading = isLoadingTxList || isLoadingSolanaTxs;

  // Build transactions from Redis (cross-chain) and Solana wallet
  const redisTxs = buildTransactionsFromRedis(txList ?? []);
  const solanaTxsFormatted = buildSolanaTransactions(solanaTxs, account);

  // Combine, deduplicate by ID, and sort by timestamp (newest first)
  const allTransactions = [...redisTxs, ...solanaTxsFormatted]
    .filter((tx, index, self) => self.findIndex(t => t.id === tx.id) === index)
    .sort((a, b) => {
      const aTime = a.timestampRaw || 0;
      const bTime = b.timestampRaw || 0;
      return bTime - aTime;
    });

  const displayTransactions = allTransactions.slice(0, 5);

  const handleRowClick = (transaction: ActivityTransaction) => {
    setSelectedTransaction(transaction);
    setDialogOpen(true);
  };

  return (
    <div className={cn('w-full', className)}>
      <div className='mb-6'>
        <h2 className='text-dark-neutral-200 self-start font-semibold uppercase'>
          Activity
        </h2>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className='w-20 sm:w-24'>Activity</TableHead>
            <TableHead>Details</TableHead>
            <TableHead className='w-20 sm:w-28'>
              <span className='hidden sm:inline'>Timestamp</span>
              <span className='sm:hidden'>Time</span>
            </TableHead>
            <TableHead className='w-20 sm:w-24'>Status</TableHead>
            <TableHead className='w-12 sm:w-16'>
              <span className='sr-only sm:not-sr-only'>Explorer</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            Array.from({ length: 3 }).map((_, index) => (
              <TableRow key={`loading-${index}`}>
                <TableCell>
                  <div className='h-4 w-12 animate-pulse rounded bg-gray-200'></div>
                </TableCell>
                <TableCell>
                  <div className='flex items-center gap-2'>
                    <div className='h-8 w-8 animate-pulse rounded-full bg-gray-200'></div>
                    <div className='space-y-1'>
                      <div className='h-3 w-16 animate-pulse rounded bg-gray-200'></div>
                      <div className='h-3 w-20 animate-pulse rounded bg-gray-200'></div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className='h-4 w-12 animate-pulse rounded bg-gray-200'></div>
                </TableCell>
                <TableCell>
                  <div className='h-6 w-16 animate-pulse rounded-full bg-gray-200'></div>
                </TableCell>
                <TableCell>
                  <div className='h-4 w-4 animate-pulse rounded bg-gray-200'></div>
                </TableCell>
              </TableRow>
            ))
          ) : displayTransactions.length > 0 ? (
            displayTransactions.map(transaction => (
              <TableRow
                key={transaction.id}
                className='cursor-pointer transition-colors hover:bg-gray-50'
                onClick={() => handleRowClick(transaction)}
              >
                <TableCell>
                  <div className='text-tundora-50 text-xs font-medium sm:text-sm'>
                    {transaction.type}
                  </div>
                </TableCell>
                <TableCell>
                  <DetailsCell transaction={transaction} />
                </TableCell>
                <TableCell>
                  <div className='text-xs font-medium text-stone-700 sm:text-sm'>
                    {transaction.timestamp}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge
                    status={transaction.status}
                    trackingId={transaction.id}
                  />
                </TableCell>
                <TableCell>
                  {transaction.explorerUrl ? (
                    <a
                      href={transaction.explorerUrl}
                      target='_blank'
                      rel='noopener noreferrer'
                      className='inline-block h-5 w-5 transition-opacity hover:opacity-80'
                      onClick={e => e.stopPropagation()}
                    >
                      <ExternalLink className='text-tundora-50 h-5 w-5' />
                    </a>
                  ) : null}
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={5} className='py-8 text-center text-gray-500'>
                {isConnected
                  ? 'No transactions found. Send ERC20 tokens to your deposit address to see activity.'
                  : 'Connect your wallet to view transaction activity.'}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <TransactionDetailsDialog
        transaction={selectedTransaction}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}
