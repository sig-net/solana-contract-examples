'use client';

import { useState } from 'react';
import { useWallet } from '@solana/connector/react';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TokenMetadata, NetworkData } from '@/lib/constants/token-metadata';
import { useDepositAddress, useDepositSol } from '@/hooks';
import { useDepositEvmMutation } from '@/hooks/use-deposit-evm-mutation';

import { TokenSelection } from './token-selection';
import { DepositAddress } from './deposit-address';
import { DepositGeneratingState } from './deposit-generating-state';

interface DepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DepositDialog({ open, onOpenChange }: DepositDialogProps) {
  const { account, isConnected } = useWallet();
  const [selectedToken, setSelectedToken] = useState<TokenMetadata | null>(
    null,
  );
  const [selectedNetwork, setSelectedNetwork] = useState<NetworkData | null>(
    null,
  );

  const { data: depositAddress, isLoading: isGeneratingAddress } =
    useDepositAddress();
  const depositEvmMutation = useDepositEvmMutation();
  const { depositAddress: solDepositAddress } = useDepositSol();

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

  const handleTokenSelect = (token: TokenMetadata, network: NetworkData) => {
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
      await depositEvmMutation.mutateAsync({
        erc20Address: selectedToken.address,
        amount: '',
        decimals: selectedToken.decimals,
      });
      handleClose();
    } catch (err) {
      console.error('Failed to notify relayer:', err);
      handleClose();
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

        {step === 'generating-address' && selectedToken && (
          <DepositGeneratingState token={selectedToken} network={selectedNetwork!} />
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
