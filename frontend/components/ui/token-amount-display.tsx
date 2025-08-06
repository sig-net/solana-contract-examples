'use client';

import { ChevronDown } from 'lucide-react';

import { CryptoIcon } from '@/components/balance-display/crypto-icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Token } from '@/lib/types/token.types';

interface TokenAmountToken extends Token {
  balance: string; // Required balance as string for this display component
}

interface TokenAmountDisplayProps {
  value: string;
  onChange: (value: string) => void;
  tokens: TokenAmountToken[];
  selectedToken?: TokenAmountToken;
  onTokenSelect: (token: TokenAmountToken) => void;
  usdValue?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}

export function TokenAmountDisplay({
  value,
  onChange,
  tokens,
  selectedToken,
  onTokenSelect,
  usdValue,
  className = '',
  placeholder = '0.00',
  disabled = false,
}: TokenAmountDisplayProps) {
  const formatBalance = (balance: string) => {
    const num = parseFloat(balance);
    if (num === 0) return '0';
    if (num < 0.01) return '< 0.01';
    return num.toFixed(6).replace(/\.?0+$/, '');
  };

  const handleMaxClick = () => {
    if (selectedToken) {
      onChange(selectedToken.balance);
    }
  };
  return (
    <div
      className={`bg-pastels-swiss-coffee-200 border-dark-neutral-400/80 flex max-w-full flex-col gap-3 rounded-xs border p-4 sm:p-5 ${className}`}
    >
      <div className='flex w-full min-w-0 items-center justify-between gap-2'>
        <div className='flex min-w-0 flex-1 items-center gap-2'>
          <input
            type='text'
            value={value}
            onChange={e => !disabled && onChange(e.target.value)}
            placeholder={placeholder}
            className='text-dark-neutral-500 w-full min-w-0 border-none bg-transparent text-lg outline-none sm:text-xl'
          />
          {selectedToken && !disabled && (
            <button
              type='button'
              onClick={handleMaxClick}
              className='text-dark-neutral-300 hover:text-dark-neutral-400 shrink-0 text-xs font-medium underline decoration-dotted underline-offset-2'
            >
              max
            </button>
          )}
        </div>

        <DropdownMenu open={disabled ? false : undefined}>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <button className='bg-pastels-pampas-500 border-dark-neutral-50 text-dark-neutral-400 flex w-24 shrink-0 items-center justify-between gap-2 rounded-xs border px-2 py-1 font-medium outline-none sm:w-30'>
              {selectedToken ? (
                <div className='flex items-center gap-2'>
                  <CryptoIcon
                    chain={selectedToken.chain}
                    token={selectedToken.symbol}
                    className='size-4'
                  />
                  <span className='text-sm'>{selectedToken.symbol}</span>
                </div>
              ) : (
                <span className='text-sm'>Select</span>
              )}
              <ChevronDown className='text-dark-neutral-400 size-4' />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align='end'
            className='w-30 min-w-0 space-y-1 rounded-xs'
          >
            {tokens.map((token, index) => (
              <DropdownMenuItem
                key={`${token.chain}-${token.erc20Address}-${index}`}
                onClick={() => onTokenSelect(token)}
                className='text-dark-neutral-400 flex cursor-pointer items-center gap-3 rounded-xs px-1 py-0 font-medium'
              >
                <CryptoIcon
                  chain={token.chain}
                  token={token.symbol}
                  className='size-4'
                />
                <span>{token.symbol}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {(usdValue || selectedToken) && (
        <div className='flex flex-col gap-1'>
          {usdValue && (
            <div className='flex items-center'>
              <span className='text-dark-neutral-200 text-xs font-medium'>
                {usdValue}
              </span>
            </div>
          )}

          {selectedToken && (
            <div className='flex items-center'>
              <span className='text-dark-neutral-300 text-xs font-medium'>
                Available: {formatBalance(selectedToken.balance)}{' '}
                {selectedToken.symbol}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
