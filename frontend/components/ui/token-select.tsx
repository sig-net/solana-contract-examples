'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { TokenListItem } from '@/components/deposit-dialog/token-list-item';
import { CryptoIcon } from '@/components/balance-display/crypto-icon';

export interface Token {
  symbol: string;
  name: string;
  chain: string;
  chainName?: string;
  balance?: string;
  balanceUsd?: string;
}

interface TokenSelectProps {
  tokens: Token[];
  value?: Token;
  onChange?: (token: Token) => void;
  placeholder?: string;
  className?: string;
  showBalance?: boolean;
}

export function TokenSelect({
  tokens,
  value,
  onChange,
  placeholder = 'Select a token',
  className,
  showBalance = true,
}: TokenSelectProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'border-dark-neutral-50 hover:border-dark-neutral-200 focus:border-dark-neutral-400 focus:ring-dark-neutral-400 flex w-full items-center justify-between rounded-sm border bg-white px-3 py-2 text-sm transition-colors focus:ring-1 focus:ring-offset-0 focus:outline-none',
            className,
          )}
          aria-expanded={open}
          aria-haspopup='listbox'
        >
          {value ? (
            <div className='flex items-center gap-3'>
              <CryptoIcon
                chain={value.chain}
                token={value.symbol}
                className='size-6'
              />
              <div className='text-left'>
                <span className='font-medium text-stone-700'>
                  {value.symbol}
                </span>
                <span className='text-dark-neutral-300 ml-2 text-xs'>
                  on {value.chainName || value.chain}
                </span>
              </div>
            </div>
          ) : (
            <span className='text-dark-neutral-300'>{placeholder}</span>
          )}
          <ChevronDown className='text-dark-neutral-400 h-4 w-4' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className='w-[var(--radix-popover-trigger-width)] p-0'
        align='start'
      >
        <div className='max-h-96 overflow-y-auto'>
          <div className='text-dark-neutral-300 p-2 text-xs font-medium uppercase'>
            In your wallet
          </div>
          {tokens.map((token, index) => (
            <TokenListItem
              key={`${token.chain}-${token.symbol}-${index}`}
              symbol={token.symbol}
              name={token.name}
              chain={token.chainName || token.chain}
              balance={showBalance ? token.balance : undefined}
              balanceUsd={showBalance ? token.balanceUsd : undefined}
              selected={
                value?.symbol === token.symbol && value?.chain === token.chain
              }
              onClick={() => {
                onChange?.(token);
                setOpen(false);
              }}
              className='rounded-none border-0'
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
