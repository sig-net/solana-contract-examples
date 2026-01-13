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
            {children}
          </AppProvider>
        </ConnectionProvider>
      </WagmiProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
