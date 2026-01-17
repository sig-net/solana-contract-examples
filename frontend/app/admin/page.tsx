'use client';

import { Buffer } from 'buffer';

import { useState } from 'react';
import { Program, AnchorProvider } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { toast } from 'sonner';

import { useConnection } from '@/providers/connection-context';
import { useAnchorWallet } from '@/hooks/use-anchor-wallet';
import { BRIDGE_PROGRAM_ID } from '@/lib/constants/addresses';
import { IDL } from '@/lib/program/idl-sol-dex';

const CONFIG_SEED = 'vault_config';

function deriveConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(CONFIG_SEED)],
    BRIDGE_PROGRAM_ID,
  )[0];
}

export default function AdminPage() {
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();
  const [mpcAddress, setMpcAddress] = useState('');
  const [loading, setLoading] = useState<'idle' | 'init' | 'update'>('idle');

  const provider = anchorWallet
    ? new AnchorProvider(connection, anchorWallet, {
        commitment: 'confirmed',
        skipPreflight: true,
      })
    : null;

  const program = provider ? new Program(IDL, provider) : null;

  async function onInitialize() {
    if (!program || !anchorWallet?.publicKey) {
      toast.error('Connect your wallet');
      return;
    }
    try {
      setLoading('init');
      const configPda = deriveConfigPda();

      const mpcBytes = Uint8Array.from(
        Buffer.from(mpcAddress.replace(/^0x/, ''), 'hex'),
      );
      if (mpcBytes.length !== 20)
        throw new Error('MPC address must be 20 bytes');

      const initMethod = program.methods.initializeConfig;
      if (!initMethod) throw new Error('initializeConfig method not found');

      const sig = await initMethod(Array.from(mpcBytes))
        .accountsStrict({
          payer: anchorWallet.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        } as never)
        .rpc();

      toast.success('Initialized config: ' + sig);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to initialize';
      toast.error(message);
    } finally {
      setLoading('idle');
    }
  }

  async function onUpdate() {
    if (!program || !anchorWallet?.publicKey) {
      toast.error('Connect your wallet');
      return;
    }
    try {
      setLoading('update');
      const configPda = deriveConfigPda();
      const mpcBytes = Uint8Array.from(
        Buffer.from(mpcAddress.replace(/^0x/, ''), 'hex'),
      );
      if (mpcBytes.length !== 20)
        throw new Error('MPC address must be 20 bytes');

      const updateMethod = program.methods.updateConfig;
      if (!updateMethod) throw new Error('updateConfig method not found');

      const sig = await updateMethod(Array.from(mpcBytes))
        .accountsStrict({
          config: configPda,
        } as never)
        .rpc();

      toast.success('Updated config: ' + sig);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to update';
      toast.error(message);
    } finally {
      setLoading('idle');
    }
  }

  return (
    <div className='mx-auto max-w-xl space-y-6 p-4'>
      <h1 className='text-xl font-semibold'>Admin Config</h1>

      <div className='space-y-2'>
        <label className='block text-sm'>MPC Root Signer (0x…20 bytes)</label>
        <input
          className='w-full rounded border px-3 py-2'
          placeholder='0x...'
          value={mpcAddress}
          onChange={e => setMpcAddress(e.target.value)}
        />
      </div>

      <div className='flex gap-2'>
        <button
          disabled={loading !== 'idle'}
          onClick={onInitialize}
          className='rounded border px-4 py-2 disabled:opacity-50'
        >
          Initialize
        </button>
        <button
          disabled={loading !== 'idle'}
          onClick={onUpdate}
          className='rounded border px-4 py-2 disabled:opacity-50'
        >
          Update
        </button>
      </div>
    </div>
  );
}
