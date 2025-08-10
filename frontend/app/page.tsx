'use client';

import { useWallet } from '@solana/wallet-adapter-react';

import { NavigationHeader } from '@/components/navigation-header';
import { BalanceSection } from '@/components/balance-section';
import { SwapWidget } from '@/components/swap-widget';
import { ActivityListTable } from '@/components/activity-list-table';
import { EmptyStateWallet } from '@/components/empty-state-wallet';
import { useBridgeAutoRefetch } from '@/hooks/use-bridge-auto-refetch';

export default function Home() {
  const { publicKey } = useWallet();
  useBridgeAutoRefetch();

  const handleSettingsClick = () => {
    // TODO: Implement settings functionality
  };

  // Check if wallet is connected
  const isWalletConnected = !!publicKey;

  return (
    <div className='gradient-bg-main min-h-screen w-full overflow-x-hidden'>
      <NavigationHeader onSettingsClick={handleSettingsClick} />

      {!isWalletConnected ? (
        <div className='mx-auto mt-16 max-w-full p-4 xl:container'>
          <EmptyStateWallet />
        </div>
      ) : (
        <div className='mx-auto mt-8 max-w-full p-4 pb-16 lg:mt-16 xl:container'>
          <div className='flex flex-col gap-6 lg:flex-row lg:gap-8'>
            <div className='order-1 w-full lg:order-2 lg:w-auto lg:shrink-0'>
              <SwapWidget />
            </div>

            <div className='order-2 flex w-full flex-col gap-8 lg:order-1 lg:flex-1 lg:gap-12'>
              <BalanceSection />
              <ActivityListTable />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const dynamic = 'force-dynamic';
