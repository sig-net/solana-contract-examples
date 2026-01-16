'use client';

import { useState } from 'react';
import {
  useWallet,
  useWalletConnectors,
  useDisconnectWallet,
  WalletListElement,
} from '@solana/connector/react';
import { toast } from 'sonner';
import { Wallet, LogOut } from 'lucide-react';
import Image from 'next/image';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { formatAddress } from '@/lib/address-utils';

export function WalletButton() {
  const [modalOpen, setModalOpen] = useState(false);
  const { account, isConnected, isConnecting } = useWallet();
  const connectors = useWalletConnectors();
  const { disconnect, isDisconnecting } = useDisconnectWallet();

  const installedConnectors = connectors.filter(c => c.ready);

  const handleDisconnect = async () => {
    try {
      await disconnect();
    } catch {
      toast.error('Failed to disconnect wallet');
    }
  };

  const showNoWalletToast = () => {
    const isMobile =
      typeof navigator !== 'undefined' &&
      /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    const currentUrl =
      typeof window !== 'undefined' ? window.location.href : '';

    const phantomDeepLink = currentUrl
      ? `https://phantom.app/ul/browse/${encodeURIComponent(
          currentUrl,
        )}?ref=${encodeURIComponent(currentUrl)}`
      : 'https://phantom.app/download';

    const phantomHref = isMobile ? phantomDeepLink : 'https://phantom.app/download';

    toast.info(
      <div>
        No Solana wallet detected. Open in{' '}
        <a
          href={phantomHref}
          target='_blank'
          rel='noreferrer'
          className='underline'
        >
          Phantom
        </a>
        . On mobile, this link will open the app if installed or route you to
        install it.
      </div>,
    );
  };

  const openModal = () => {
    if (installedConnectors.length === 0) {
      showNoWalletToast();
      return;
    }
    setModalOpen(true);
  };

  if (isConnecting) {
    return (
      <Button disabled>
        <Wallet className='mr-2 h-4 w-4' />
        Connecting...
      </Button>
    );
  }

  if (isConnected && account) {
    return (
      <div className='flex items-center gap-2'>
        <Button variant='outline' className='gap-2 font-medium'>
          <Wallet className='h-4 w-4' />
          {formatAddress(account, 4, 4)}
        </Button>
        <Button
          variant='outline'
          onClick={handleDisconnect}
          disabled={isDisconnecting}
          className='border-red-200 bg-red-50 font-medium text-red-600'
          title='Disconnect wallet'
        >
          <LogOut className='h-4 w-4' />
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button onClick={openModal} className='font-medium'>
        <Wallet className='mr-2 h-4 w-4' />
        Connect Wallet
      </Button>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect a Wallet</DialogTitle>
            <DialogDescription>
              Select a wallet to connect to this app.
            </DialogDescription>
          </DialogHeader>

          <WalletListElement
            installedOnly
            onConnect={() => setModalOpen(false)}
            render={({ installedWallets, connectById, connecting }) => (
              <ul className='flex flex-col gap-1.5'>
                {installedWallets.map(wallet => (
                  <li key={wallet.connectorId}>
                    <button
                      type='button'
                      onClick={() => {
                        connectById(wallet.connectorId).catch(() => {
                          toast.error('Failed to connect wallet');
                        });
                      }}
                      disabled={connecting}
                      className='flex w-full cursor-pointer items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-left transition-all duration-150 hover:border-gray-300 hover:bg-gray-50 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50'
                    >
                      <div className='flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md'>
                        {wallet.icon ? (
                          <Image
                            src={wallet.icon}
                            alt={wallet.name}
                            width={36}
                            height={36}
                            className='h-full w-full object-contain'
                            unoptimized
                          />
                        ) : (
                          <Wallet className='h-5 w-5 text-gray-400' />
                        )}
                      </div>
                      <span className='text-sm font-medium text-gray-900'>
                        {wallet.name}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
