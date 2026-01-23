import { after } from 'next/server';
import { NextRequest, NextResponse } from 'next/server';
import { toBytes } from 'viem';
import { Connection, Keypair } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';

import { recoverDeposit, recoverWithdrawal } from '@/lib/relayer/handlers';
import { registerTx } from '@/lib/relayer/tx-registry';
import {
  derivePendingDepositPda,
  derivePendingWithdrawalPda,
} from '@/lib/constants/addresses';
import { IDL, type SolanaDexContract } from '@/lib/program/idl-sol-dex';
import { getFullEnv } from '@/lib/config/env.config';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { requestId, type, userAddress, erc20Address } = body;

    if (!requestId || !type || !userAddress) {
      return NextResponse.json(
        { error: 'Missing required fields: requestId, type, userAddress' },
        { status: 400 },
      );
    }

    if (type !== 'deposit' && type !== 'withdrawal') {
      return NextResponse.json(
        { error: 'Invalid type: must be deposit or withdrawal' },
        { status: 400 },
      );
    }

    const env = getFullEnv();
    const connection = new Connection(
      `https://solana-devnet.g.alchemy.com/v2/${env.NEXT_PUBLIC_ALCHEMY_API_KEY}`,
      'confirmed',
    );

    // Create a minimal wallet for reading accounts
    const keypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(env.RELAYER_PRIVATE_KEY)),
    );
    const wallet = {
      publicKey: keypair.publicKey,
      signTransaction: () => {
        throw new Error('Not implemented');
      },
      signAllTransactions: () => {
        throw new Error('Not implemented');
      },
    } as unknown as Wallet;

    const provider = new AnchorProvider(connection, wallet, {
      commitment: 'confirmed',
    });
    const program = new Program<SolanaDexContract>(IDL, provider);

    const requestIdBytes = Array.from(toBytes(requestId as `0x${string}`));

    if (type === 'deposit') {
      const [pendingDepositPda] = derivePendingDepositPda(requestIdBytes);

      let pendingDeposit;
      try {
        pendingDeposit = await program.account.pendingErc20Deposit.fetch(
          pendingDepositPda,
        );
      } catch {
        return NextResponse.json(
          { error: 'No pending deposit found' },
          { status: 404 },
        );
      }

      // Verify user owns this deposit
      if (pendingDeposit.requester.toBase58() !== userAddress) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
      }

      // Re-trigger completion flow
      await registerTx(requestId, 'deposit', userAddress);

      after(async () => {
        try {
          const result = await recoverDeposit(requestId, {
            requester: pendingDeposit.requester,
            erc20Address: pendingDeposit.erc20Address as number[],
          });
          if (!result.ok) {
            console.error('Deposit recovery failed:', result.error);
          } else {
            console.log('Deposit recovered successfully:', result.solanaTx);
          }
        } catch (error) {
          console.error('Deposit recovery error:', error);
        }
      });

      return NextResponse.json(
        { accepted: true, message: 'Recovery initiated' },
        { status: 202 },
      );
    }

    if (type === 'withdrawal') {
      if (!erc20Address) {
        return NextResponse.json(
          { error: 'Missing erc20Address for withdrawal recovery' },
          { status: 400 },
        );
      }

      const [pendingWithdrawalPda] = derivePendingWithdrawalPda(requestIdBytes);

      let pendingWithdrawal;
      try {
        pendingWithdrawal = await program.account.pendingErc20Withdrawal.fetch(
          pendingWithdrawalPda,
        );
      } catch {
        return NextResponse.json(
          { error: 'No pending withdrawal found' },
          { status: 404 },
        );
      }

      // Verify user owns this withdrawal
      if (pendingWithdrawal.requester.toBase58() !== userAddress) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
      }

      // Re-trigger completion flow
      await registerTx(requestId, 'withdrawal', userAddress);

      after(async () => {
        try {
          const result = await recoverWithdrawal(
            requestId,
            { requester: pendingWithdrawal.requester.toBase58() },
            erc20Address,
          );
          if (!result.ok) {
            console.error('Withdrawal recovery failed:', result.error);
          } else {
            console.log('Withdrawal recovered successfully:', result.solanaTx);
          }
        } catch (error) {
          console.error('Withdrawal recovery error:', error);
        }
      });

      return NextResponse.json(
        { accepted: true, message: 'Recovery initiated' },
        { status: 202 },
      );
    }

    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
