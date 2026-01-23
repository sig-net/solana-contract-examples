'use client';

import { AppProvider } from '@solana/connector/react';
import { getDefaultConfig } from '@solana/connector/headless';
import { WagmiProvider } from 'wagmi';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

import { wagmiConfig } from '@/lib/wagmi/config';
import { queryClient } from '@/lib/query-client';
import { getAlchemySolanaDevnetRpcUrl } from '@/lib/rpc';
import { ConnectionProvider } from './connection-context';
import { PendingTransactionsProvider } from './pending-transactions-context';
import { TransactionStatusTracker } from '@/components/transaction-status-tracker';

const endpoint = getAlchemySolanaDevnetRpcUrl();

const connectionConfig = {
  commitment: 'confirmed' as const,
  disableRetryOnRateLimit: false,
  confirmTransactionInitialTimeout: 30000,
};

const connectorConfig = getDefaultConfig({
  appName: 'Signet Bridge',
  network: 'devnet',
  autoConnect: true,
  clusters: [
    {
      id: 'solana:devnet' as const,
      label: 'Devnet',
      url: endpoint,
    },
  ],
});

interface ProvidersProps {
  children: React.ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={wagmiConfig}>
        <ConnectionProvider endpoint={endpoint} config={connectionConfig}>
          <AppProvider connectorConfig={connectorConfig}>
            <PendingTransactionsProvider>
              {children}
              <TransactionStatusTracker />
            </PendingTransactionsProvider>
          </AppProvider>
        </ConnectionProvider>
      </WagmiProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
