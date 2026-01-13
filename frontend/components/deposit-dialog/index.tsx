'use client';

import { useState, useEffect } from 'react';
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

enum DepositStep {
  SELECT_TOKEN = 'select-token',
  GENERATING_ADDRESS = 'generating-address',
  SHOW_ADDRESS = 'show-address',
}

export function DepositDialog({ open, onOpenChange }: DepositDialogProps) {
  const { account, isConnected } = useWallet();
  const [step, setStep] = useState<DepositStep>(DepositStep.SELECT_TOKEN);
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

  const handleTokenSelect = (token: TokenMetadata, network: NetworkData) => {
    setSelectedToken(token);
    setSelectedNetwork(network);
    setStep(DepositStep.GENERATING_ADDRESS);
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
    setStep(DepositStep.SELECT_TOKEN);
    setSelectedToken(null);
    setSelectedNetwork(null);
    onOpenChange(false);
  };

  useEffect(() => {
    if (step !== DepositStep.GENERATING_ADDRESS) return;
    if (!selectedNetwork) return;

    // For Solana network, we already have the user's own wallet address; no generation needed
    if (selectedNetwork.chain === 'solana' && isConnected && account) {
      setStep(DepositStep.SHOW_ADDRESS);
      return;
    }

    if (depositAddress && !isGeneratingAddress) {
      setStep(DepositStep.SHOW_ADDRESS);
    }
  }, [step, selectedNetwork, isConnected, account, depositAddress, isGeneratingAddress]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className='gradient-popover max-w-md rounded-sm p-10 shadow-[0px_4px_9.3px_0px_rgba(41,86,70,0.35)]'>
        {step === DepositStep.SELECT_TOKEN && (
          <div className='space-y-5'>
            <DialogHeader className='space-y-0 p-0'>
              <DialogTitle className='text-dark-neutral-400 text-xl font-semibold'>
                Select an asset
              </DialogTitle>
            </DialogHeader>
            <TokenSelection onTokenSelect={handleTokenSelect} />
          </div>
        )}

        {step === DepositStep.GENERATING_ADDRESS && selectedToken && (
          <DepositGeneratingState token={selectedToken} network={selectedNetwork!} />
        )}

        {step === DepositStep.SHOW_ADDRESS &&
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
