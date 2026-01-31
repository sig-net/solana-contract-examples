'use client';

import { useState } from 'react';
import { useWallet } from '@solana/connector/react';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CryptoIcon } from '@/components/balance-display/crypto-icon';
import { TokenConfig, NetworkData, fetchErc20Decimals } from '@/lib/constants/token-metadata';
import { useDepositAddress } from '@/hooks';
import { useDepositEvmMutation } from '@/hooks/use-deposit-evm-mutation';

import { TokenSelection } from './token-selection';
import { DepositAddress } from './deposit-address';

interface DepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DepositDialog({ open, onOpenChange }: DepositDialogProps) {
  const { account, isConnected } = useWallet();
  const [selectedToken, setSelectedToken] = useState<TokenConfig | null>(
    null,
  );
  const [selectedNetwork, setSelectedNetwork] = useState<NetworkData | null>(
    null,
  );

  const { data: depositAddress, isLoading: isGeneratingAddress } =
    useDepositAddress();
  const depositEvmMutation = useDepositEvmMutation();
  const solDepositAddress = account ?? '';

  // Derive step from state instead of syncing with useEffect
  const getStep = () => {
    if (!selectedToken || !selectedNetwork) {
      return 'select-token';
    }

    // Solana: skip generating step, address is always available
    if (selectedNetwork.chain === 'solana' && isConnected && account) {
      return 'show-address';
    }

    // EVM: show generating while loading, then show address
    if (!depositAddress || isGeneratingAddress) {
      return 'generating-address';
    }

    return 'show-address';
  };

  const step = getStep();

  const handleTokenSelect = (token: TokenConfig, network: NetworkData) => {
    setSelectedToken(token);
    setSelectedNetwork(network);
  };

  const handleNotifyRelayer = async () => {
    if (!isConnected || !account || !selectedToken || !selectedNetwork) return;

    // For Solana assets, no relayer notification is needed; user deposits directly to own wallet
    if (selectedNetwork.chain === 'solana') {
      handleClose();
      return;
    }

    try {
      // Fetch decimals from chain
      const decimals = await fetchErc20Decimals(selectedToken.erc20Address);

      await depositEvmMutation.mutateAsync({
        erc20Address: selectedToken.erc20Address,
        amount: '',
        decimals,
        tokenSymbol: selectedToken.symbol,
      });
      handleClose();
    } catch (err) {
      toast.error('Failed to notify relayer', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  const handleClose = () => {
    setSelectedToken(null);
    setSelectedNetwork(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className='gradient-popover max-w-md rounded-sm p-10 shadow-[0px_4px_9.3px_0px_rgba(41,86,70,0.35)]'>
        {step === 'select-token' && (
          <div className='space-y-5'>
            <DialogHeader className='space-y-0 p-0'>
              <DialogTitle className='text-dark-neutral-400 text-xl font-semibold'>
                Select an asset
              </DialogTitle>
            </DialogHeader>
            <TokenSelection onTokenSelect={handleTokenSelect} />
          </div>
        )}

        {step === 'generating-address' && selectedToken && selectedNetwork && (
          <div className='space-y-6 text-center'>
            <div className='flex flex-col items-center gap-4'>
              <CryptoIcon
                chain={selectedNetwork.chain}
                token={selectedToken.symbol}
                className='size-12'
              />
              <div>
                <h3 className='text-tundora-300 mb-1 text-lg font-semibold'>
                  Generating Deposit Address
                </h3>
                <p className='text-tundora-50 text-sm font-medium'>
                  {selectedToken.symbol} on {selectedNetwork.chainName}
                </p>
              </div>
            </div>

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

            <p className='text-dark-neutral-400 text-sm font-medium'>
              Please wait while we generate your unique deposit address...
            </p>
          </div>
        )}

        {step === 'show-address' &&
          selectedToken &&
          selectedNetwork && (
            <div className='space-y-5'>
              <DialogHeader className='space-y-0 p-0'>
                <DialogTitle className='text-dark-neutral-400 text-xl font-semibold'>
                  Deposit Address
                </DialogTitle>
              </DialogHeader>
              <DepositAddress
                token={selectedToken}
                network={selectedNetwork}
                depositAddress={
                  selectedNetwork.chain === 'solana'
                    ? solDepositAddress
                    : depositAddress || ''
                }
                onContinue={handleNotifyRelayer}
              />
            </div>
          )}
      </DialogContent>
    </Dialog>
  );
}
