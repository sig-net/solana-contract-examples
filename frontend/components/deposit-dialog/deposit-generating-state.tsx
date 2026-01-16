'use client';

import { CryptoIcon } from '@/components/balance-display/crypto-icon';
import type {
  TokenMetadata,
  NetworkData,
} from '@/lib/constants/token-metadata';

interface DepositGeneratingStateProps {
  token: TokenMetadata;
  network: NetworkData;
}

export function DepositGeneratingState({ token, network }: DepositGeneratingStateProps) {
  return (
    <div className='space-y-6 text-center'>
      {/* Token Info */}
      <div className='flex flex-col items-center gap-4'>
        <CryptoIcon
          chain={network.chain}
          token={token.symbol}
          className='size-12'
        />
        <div>
          <h3 className='text-tundora-300 mb-1 text-lg font-semibold'>
            Generating Deposit Address
          </h3>
          <p className='text-tundora-50 text-sm font-medium'>
            {token.symbol} on {network.chainName}
          </p>
        </div>
      </div>

      {/* Loading Animation */}
      <div className='flex justify-center'>
        <div className='flex gap-1'>
          <div className='bg-dark-neutral-300 h-2 w-2 animate-bounce rounded-full'></div>
          <div
            className='bg-dark-neutral-300 h-2 w-2 animate-bounce rounded-full'
            style={{ animationDelay: '0.1s' }}
          ></div>
          <div
            className='bg-dark-neutral-300 h-2 w-2 animate-bounce rounded-full'
            style={{ animationDelay: '0.2s' }}
          ></div>
        </div>
      </div>

      {/* Status Text */}
      <p className='text-dark-neutral-400 text-sm font-medium'>
        Please wait while we generate your unique deposit address...
      </p>
    </div>
  );
}
