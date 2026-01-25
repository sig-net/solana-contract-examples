'use client';

import { useState } from 'react';
import { ArrowDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  Erc20TokenMetadata,
  getAllErc20Tokens,
  getTokenMetadata,
} from '@/lib/constants/token-metadata';
import { TokenAmountDisplay } from '@/components/ui/token-amount-display';
import type { Token } from '@/lib/types/token.types';

import { Button } from '../ui/button';

import { SwapHeader } from './swap-header';

interface SwapWidgetProps {
  className?: string;
  availableTokens?: Erc20TokenMetadata[];
  onSwap?: (
    fromToken: Erc20TokenMetadata | null,
    toToken: Erc20TokenMetadata | null,
    fromAmount: string,
    toAmount: string,
  ) => void;
  onTokenSelect?: (
    token: Erc20TokenMetadata | null,
    side: 'from' | 'to',
  ) => void;
  loading?: boolean;
  error?: string | null;
}

interface SwapState {
  fromToken: Erc20TokenMetadata | null;
  toToken: Erc20TokenMetadata | null;
  fromAmount: string;
  toAmount: string;
  isSwapping: boolean;
}

export function SwapWidget({ className }: Pick<SwapWidgetProps, 'className'>) {
  const [swapState, setSwapState] = useState<SwapState>({
    fromToken: null,
    toToken: null,
    fromAmount: '',
    toAmount: '',
    isSwapping: false,
  });

  // Helper function to convert metadata to Token (UI type)
  // Only works for tokens with loaded decimals
  const tokenMetadataToToken = (
    tokenMetadata: Erc20TokenMetadata & { decimals: number },
  ): Token & { balance: string } => ({
    symbol: tokenMetadata.symbol,
    name: tokenMetadata.name,
    chain: 'ethereum' as const,
    erc20Address: tokenMetadata.address,
    decimals: tokenMetadata.decimals,
    balance: '0',
  });

  // Helper function to convert UI Token to metadata (by address)
  const tokenToTokenMetadata = (token: Token): Erc20TokenMetadata | null => {
    return getTokenMetadata(token.erc20Address) || null;
  };

  // Convert supported tokens (filter out those without loaded decimals)
  const supportedTokens: Array<Token & { balance: string }> = getAllErc20Tokens()
    .filter((t): t is Erc20TokenMetadata & { decimals: number } => t.decimals !== undefined)
    .map(tokenMetadataToToken);

  const handleFromAmountChange = (amount: string) => {
    setSwapState(prev => ({ ...prev, fromAmount: amount }));
  };

  const handleToAmountChange = (amount: string) => {
    setSwapState(prev => ({ ...prev, toAmount: amount }));
  };

  const handleFromTokenSelect = (token: Token) => {
    const tokenMetadata = tokenToTokenMetadata(token);
    setSwapState(prev => ({ ...prev, fromToken: tokenMetadata }));
  };

  const handleToTokenSelect = (token: Token) => {
    const tokenMetadata = tokenToTokenMetadata(token);
    setSwapState(prev => ({ ...prev, toToken: tokenMetadata }));
  };

  const handleSwap = () => {};

  return (
    <div
      className={cn(
        'border-dark-neutral-50 gradient-bg-swap relative w-full max-w-full shrink-0 space-y-6 self-start border p-4 sm:p-6 lg:max-w-sm lg:p-8',
        className,
      )}
    >
      <SwapHeader
        onSettingsClick={() => {
          // TODO: Implement settings functionality
        }}
      />

      <div className='flex flex-col gap-4'>
        <TokenAmountDisplay
          value={swapState.fromAmount}
          onChange={handleFromAmountChange}
          tokens={supportedTokens}
          selectedToken={
            swapState.fromToken && swapState.fromToken.decimals !== undefined
              ? tokenMetadataToToken(swapState.fromToken as Erc20TokenMetadata & { decimals: number })
              : undefined
          }
          onTokenSelect={handleFromTokenSelect}
          placeholder='0'
          disabled={true}
        />

        <div className='flex justify-center'>
          <ArrowDown className='text-dark-neutral-300 h-5 w-5' />
        </div>

        <TokenAmountDisplay
          value={swapState.toAmount}
          onChange={handleToAmountChange}
          tokens={supportedTokens}
          selectedToken={
            swapState.toToken && swapState.toToken.decimals !== undefined
              ? tokenMetadataToToken(swapState.toToken as Erc20TokenMetadata & { decimals: number })
              : undefined
          }
          onTokenSelect={handleToTokenSelect}
          placeholder='0'
          disabled={true}
        />
      </div>

      <Button
        onClick={handleSwap}
        disabled
        variant='secondary'
        size='lg'
        className='w-full'
      >
        Swap
      </Button>
    </div>
  );
}
