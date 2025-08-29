'use client';

import { Buffer } from 'buffer';

import { useCallback, useMemo, useState } from 'react';
import { Program, AnchorProvider } from '@coral-xyz/anchor';
import { useConnection, useAnchorWallet } from '@solana/wallet-adapter-react';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { toast } from 'sonner';

import { BRIDGE_PROGRAM_ID } from '@/lib/constants/addresses';
import { IDL, type SolDexIDL } from '@/lib/program/idl-sol-dex';

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

  const provider = useMemo(() => {
    if (!anchorWallet) return null;
    return new AnchorProvider(connection, anchorWallet, {
      commitment: 'confirmed',
      skipPreflight: true,
    });
  }, [connection, anchorWallet]);

  const program = useMemo(() => {
    if (!provider) return null;
    return new Program(IDL as unknown as SolDexIDL, provider);
  }, [provider]);

  const onInitialize = useCallback(async () => {
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

      const sig = await program.methods
        .initializeConfig(Array.from(mpcBytes))
        .accountsStrict({
          payer: anchorWallet.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        } as never)
        .rpc();

      toast.success('Initialized config: ' + sig);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to initialize');
    } finally {
      setLoading('idle');
    }
  }, [program, anchorWallet, mpcAddress]);

  const onUpdate = useCallback(async () => {
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

      const sig = await program.methods
        .updateConfig(Array.from(mpcBytes))
        .accountsStrict({
          config: configPda,
        } as never)
        .rpc();

      toast.success('Updated config: ' + sig);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to update');
    } finally {
      setLoading('idle');
    }
  }, [program, anchorWallet, mpcAddress]);

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
