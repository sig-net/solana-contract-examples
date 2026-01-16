'use client';

import { useEffect, useState } from 'react';
import { Package } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { BalanceDisplay } from '@/components/balance-display';
import { EmptyState } from '@/components/states';
import { DepositDialog } from '@/components/deposit-dialog';
import { useUserBalances } from '@/hooks';
import { convertTokenBalancesToDisplayTokens } from '@/lib/utils';

export function BalanceSection() {
  const { data: userBalances = [], isLoading, error } = useUserBalances();
  const [isDepositDialogOpen, setIsDepositDialogOpen] = useState(false);

  const handleDepositClick = () => {
    setIsDepositDialogOpen(true);
  };

  const displayTokens = convertTokenBalancesToDisplayTokens(userBalances);

  useEffect(() => {
    if (error) {
      console.error('Failed to load balances:', error);
    }
  }, [error]);

  if (isLoading) {
    return (
      <div className='flex w-full max-w-full flex-col gap-5'>
        <div className='flex items-center justify-between'>
          <div className='h-6 w-24 animate-pulse rounded bg-gray-200'></div>
          <div className='h-9 w-20 animate-pulse rounded bg-gray-200'></div>
        </div>

        <div className='grid w-full max-w-full gap-4 sm:gap-6 md:grid-cols-2 md:gap-5 lg:gap-10'>
          {Array.from({ length: 2 }).map((_, index) => (
            <div
              key={`loading-balance-${index}`}
              className='border-colors-dark-neutral-200 flex w-full max-w-full flex-col gap-4 border-t py-4 sm:flex-row sm:items-center sm:justify-between sm:py-5'
            >
              <div className='flex min-w-0 flex-1 gap-4 sm:gap-5'>
                <div className='flex min-w-0 flex-col gap-1 sm:gap-2'>
                  <div className='h-8 w-16 animate-pulse rounded bg-gray-200 sm:h-9 sm:w-20'></div>
                  <div className='h-4 w-12 animate-pulse rounded bg-gray-200'></div>
                </div>
                <div className='flex flex-shrink-0 items-center gap-3 sm:gap-4'>
                  <div className='h-7 w-7 animate-pulse rounded-full bg-gray-200'></div>
                  <div className='h-4 w-10 animate-pulse rounded bg-gray-200'></div>
                </div>
              </div>
              <div className='flex justify-end gap-2 sm:justify-start'>
                <div className='h-8 w-16 animate-pulse rounded bg-gray-200'></div>
                <div className='h-8 w-12 animate-pulse rounded bg-gray-200'></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      {displayTokens.length === 0 ? (
        <EmptyState
          icon={Package}
          title='No tokens found'
          description='Deposit some tokens to get started managing your portfolio.'
          compact
          action={
            <Button onClick={handleDepositClick} variant='default'>
              Deposit Tokens
            </Button>
          }
        />
      ) : (
        <BalanceDisplay tokens={displayTokens} />
      )}
      <DepositDialog
        open={isDepositDialogOpen}
        onOpenChange={setIsDepositDialogOpen}
      />
    </>
  );
}
