import { Wallet, ArrowDownCircle, ArrowRightLeft } from 'lucide-react';

import { WalletButton } from '@/components/wallet-button';
import { EmptyState } from '@/components/ui/empty-state';

export function EmptyStateWallet() {
  return (
    <EmptyState
      icon={Wallet}
      title='Ethereum Assets in Solana Contracts'
      description='Deposit ERC-20 tokens and your Solana program can call into Ethereum liquidity, markets, and assets'
      action={
        <>
          <div className='mb-12 flex justify-center'>
            <WalletButton />
          </div>

          <div className='grid grid-cols-2 gap-8 text-center'>
            <div className='flex flex-col items-center gap-3'>
              <div className='flex h-16 w-16 items-center justify-center rounded-full bg-green-100'>
                <ArrowDownCircle className='h-8 w-8 text-green-600' />
              </div>
              <div>
                <p className='text-dark-neutral-900 text-base font-medium'>
                  Deposit
                </p>
                <p className='text-dark-neutral-600 text-sm'>From Ethereum</p>
              </div>
            </div>

            <div className='flex flex-col items-center gap-3'>
              <div className='flex h-16 w-16 items-center justify-center rounded-full bg-purple-100'>
                <ArrowRightLeft className='h-8 w-8 text-purple-600' />
              </div>
              <div>
                <p className='text-dark-neutral-900 text-base font-medium'>
                  Manage
                </p>
                <p className='text-dark-neutral-600 text-sm'>Cross-Chain</p>
              </div>
            </div>
          </div>
        </>
      }
    />
  );
}
