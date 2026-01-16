import { useWallet } from '@solana/connector/react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { ExternalLink } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useIncomingTransfers } from '@/hooks/use-incoming-transfers';
import { useDepositAddress } from '@/hooks/use-deposit-address';
import { useOutgoingTransfers } from '@/hooks/use-outgoing-transfers';
import {
  getTokenInfoSync,
  preloadTokenInfo,
} from '@/lib/utils/token-formatting';
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

import { DetailsCell } from './details-cell';
import { StatusBadge } from './status-badge';

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
  status: 'pending' | 'processing' | 'completed' | 'failed';
  transactionHash?: string;
  explorerUrl?: string;
}

interface ActivityListTableProps {
  className?: string;
}

function buildTransactionsList(
  depositAddress: string | undefined,
  incomingTransfers: ReturnType<typeof useIncomingTransfers>['data'],
  outgoingTransfers: ReturnType<typeof useOutgoingTransfers>['data'],
  solanaTxs: ReturnType<typeof useSolanaTransactions>['data'],
  account: string | null,
): ActivityTransaction[] {
  const allTransactions: ActivityTransaction[] = [];

  // Process incoming transfers (deposits)
  if (incomingTransfers) {
    const incomingTxs = incomingTransfers.map(transfer => {
      const tokenInfo = getTokenInfoSync(transfer.tokenAddress);
      const formattedAmount = formatTokenBalanceSync(
        transfer.value,
        tokenInfo.decimals,
        tokenInfo.displaySymbol,
        { showSymbol: true },
      );

      const usdPrice = tokenInfo.displaySymbol === 'USDC' ? 1.0 : 0;
      const usdValue =
        usdPrice > 0
          ? formatTokenBalanceSync(
              transfer.value,
              tokenInfo.decimals,
              undefined,
              { showUsd: true, usdPrice },
            )
          : '$0.00';

      return {
        id: transfer.requestId,
        type: 'Deposit' as const,
        fromToken: depositAddress
          ? {
              symbol: 'WALLET',
              chain: 'ethereum',
              amount: depositAddress,
              usdValue: '',
            }
          : undefined,
        toToken: {
          symbol: tokenInfo.displaySymbol,
          chain: 'ethereum',
          amount: formattedAmount,
          usdValue: usdValue,
        },
        address: undefined,
        timestamp: transfer.timestamp
          ? formatActivityDate(transfer.timestamp)
          : 'Unknown',
        timestampRaw: transfer.timestamp,
        status: transfer.status,
        transactionHash: transfer.transactionHash,
        explorerUrl: transfer.transactionHash
          ? getTransactionExplorerUrl(transfer.transactionHash)
          : undefined,
      };
    });
    allTransactions.push(...incomingTxs);
  }

  // Process outgoing transfers (withdrawals)
  if (outgoingTransfers) {
    const outgoingTxs = outgoingTransfers.map(transfer => {
      const tokenInfo = getTokenInfoSync(transfer.tokenAddress);
      const formattedAmount = formatTokenBalanceSync(
        transfer.value,
        tokenInfo.decimals,
        tokenInfo.displaySymbol,
        { showSymbol: true },
      );

      const usdPrice = tokenInfo.displaySymbol === 'USDC' ? 1.0 : 0;
      const usdValue =
        usdPrice > 0
          ? formatTokenBalanceSync(
              transfer.value,
              tokenInfo.decimals,
              undefined,
              { showUsd: true, usdPrice },
            )
          : '$0.00';

      return {
        id: `${transfer.requestId}-outgoing`,
        type: 'Withdraw' as const,
        fromToken: {
          symbol: tokenInfo.displaySymbol,
          chain: 'ethereum',
          amount: formattedAmount,
          usdValue: usdValue,
        },
        toToken: {
          symbol: 'WALLET',
          chain: 'ethereum',
          amount: transfer.recipient,
          usdValue: '',
        },
        address: transfer.recipient,
        timestamp: transfer.timestamp
          ? formatActivityDate(transfer.timestamp)
          : 'Unknown',
        timestampRaw: transfer.timestamp,
        status: transfer.status,
        transactionHash: transfer.transactionHash,
        explorerUrl: transfer.transactionHash
          ? getTransactionExplorerUrl(transfer.transactionHash)
          : undefined,
      };
    });
    allTransactions.push(...outgoingTxs);
  }

  // Include Solana wallet transactions
  if (solanaTxs && solanaTxs.length > 0) {
    const solanaAddress = account ?? '';
    const walletTxs: ActivityTransaction[] = solanaTxs.map(tx => {
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
    allTransactions.push(...walletTxs);
  }

  // Sort all transactions by timestamp (newest first)
  return allTransactions.sort((a, b) => {
    const aTime = a.timestampRaw || 0;
    const bTime = b.timestampRaw || 0;
    return bTime - aTime;
  });
}

export function ActivityListTable({ className }: ActivityListTableProps) {
  const { isConnected, account } = useWallet();
  const { data: depositAddress } = useDepositAddress();
  const {
    data: incomingTransfers,
    isLoading: isLoadingIncoming,
    error: incomingError,
  } = useIncomingTransfers();

  const {
    data: outgoingTransfers,
    isLoading: isLoadingOutgoing,
    error: outgoingError,
  } = useOutgoingTransfers();

  const {
    data: solanaTxs,
    isLoading: isLoadingSolanaTxs,
    error: solanaTxsError,
  } = useSolanaTransactions(25);

  const isLoadingTransfers =
    isLoadingIncoming || isLoadingOutgoing || isLoadingSolanaTxs;
  const error = incomingError || outgoingError || solanaTxsError;

  useEffect(() => {
    if (error) {
      console.error('Failed to load transfers:', error);
      if (
        error instanceof Error &&
        /429|rate\s*limit|too\s*many\s*requests/i.test(error.message)
      ) {
        toast.warning('Rate limit reached. Please try again in a moment.');
      }
    }
  }, [error]);

  // Preload token information when transfers are loaded
  useEffect(() => {
    const allTransfers = [
      ...(incomingTransfers || []),
      ...(outgoingTransfers || []),
    ];
    if (allTransfers.length) {
      const tokenAddresses = Array.from(
        new Set(allTransfers.map(transfer => transfer.tokenAddress)),
      );
      preloadTokenInfo(tokenAddresses);
    }
  }, [incomingTransfers, outgoingTransfers]);

  const realTransactions = buildTransactionsList(
    depositAddress,
    incomingTransfers,
    outgoingTransfers,
    solanaTxs,
    account,
  );

  const displayTransactions = realTransactions.slice(0, 5);

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
          {isLoadingTransfers ? (
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
              <TableRow key={transaction.id}>
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
                  <StatusBadge status={transaction.status} />
                </TableCell>
                <TableCell>
                  {transaction.explorerUrl ? (
                    <a
                      href={transaction.explorerUrl}
                      target='_blank'
                      rel='noopener noreferrer'
                      className='inline-block h-5 w-5 transition-opacity hover:opacity-80'
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
    </div>
  );
}
