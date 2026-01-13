'use client';

import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react';
import { WagmiProvider } from 'wagmi';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

import { wagmiConfig } from '@/lib/wagmi/config';
import { queryClient } from '@/lib/query-client';
import { getAlchemySolanaDevnetRpcUrl } from '@/lib/rpc';

import '@solana/wallet-adapter-react-ui/styles.css';

const endpoint = getAlchemySolanaDevnetRpcUrl();

const connectionConfig = {
  commitment: 'confirmed' as const,
  disableRetryOnRateLimit: false,
  confirmTransactionInitialTimeout: 30000,
};

interface ProvidersProps {
  children: React.ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={wagmiConfig}>
        <ConnectionProvider endpoint={endpoint} config={connectionConfig}>
          <WalletProvider wallets={[]} autoConnect>
            <WalletModalProvider>{children}</WalletModalProvider>
          </WalletProvider>
        </ConnectionProvider>
      </WagmiProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
