'use client';

import { useState } from 'react';
import { ArrowDown, Settings2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { TokenAmountDisplay } from '@/components/ui/token-amount-display';
import type { Token } from '@/lib/types/token.types';

import { Button } from '../ui/button';

interface SwapWidgetProps {
  className?: string;
}

type TokenWithBalance = Token & { balance: string };

// Swap is disabled - tokens will be loaded when feature is enabled
export function SwapWidget({ className }: SwapWidgetProps) {
  const [fromAmount, setFromAmount] = useState('');
  const [toAmount, setToAmount] = useState('');
  const [fromToken, setFromToken] = useState<TokenWithBalance | undefined>();
  const [toToken, setToToken] = useState<TokenWithBalance | undefined>();

  // No tokens available until swap is enabled and decimals are fetched from chain
  const supportedTokens: TokenWithBalance[] = [];

  return (
    <div
      className={cn(
        'border-dark-neutral-50 gradient-bg-swap relative w-full max-w-full shrink-0 space-y-6 self-start border p-4 sm:p-6 lg:max-w-sm lg:p-8',
        className,
      )}
    >
      <div className='flex items-center justify-between'>
        <h2 className='text-tundora-400 text-xl font-semibold'>Swap</h2>
        <Button
          variant='ghost'
          size='icon'
          className='h-8 w-8 p-0'
          onClick={() => {}}
        >
          <Settings2 className='text-dark-neutral-300 h-6 w-6' />
        </Button>
      </div>

      <div className='flex flex-col gap-4'>
        <TokenAmountDisplay
          value={fromAmount}
          onChange={setFromAmount}
          tokens={supportedTokens}
          selectedToken={fromToken}
          onTokenSelect={setFromToken}
          placeholder='0'
          disabled={true}
        />

        <div className='flex justify-center'>
          <ArrowDown className='text-dark-neutral-300 h-5 w-5' />
        </div>

        <TokenAmountDisplay
          value={toAmount}
          onChange={setToAmount}
          tokens={supportedTokens}
          selectedToken={toToken}
          onTokenSelect={setToToken}
          placeholder='0'
          disabled={true}
        />
      </div>

      <Button onClick={() => {}} disabled variant='secondary' size='lg' className='w-full'>
        Swap
      </Button>
    </div>
  );
}
