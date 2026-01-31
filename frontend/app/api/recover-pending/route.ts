import { after } from 'next/server';
import { NextRequest, NextResponse } from 'next/server';
import { toBytes } from 'viem';
import { PublicKey, Connection } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';

import { recoverDeposit, recoverWithdrawal } from '@/lib/relayer/handlers';
import { registerTx } from '@/lib/relayer/tx-registry';
import { getRelayerSolanaKeypair } from '@/lib/utils/relayer-setup';
import {
  derivePendingDepositPda,
  derivePendingWithdrawalPda,
} from '@/lib/constants/addresses';
import { IDL, type SolanaDexContract } from '@/lib/program/idl-sol-dex';
import { getAlchemySolanaDevnetRpcUrl } from '@/lib/rpc';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

type TxType = 'deposit' | 'withdrawal';

async function recoverPendingTx<T extends { requester: PublicKey }>(params: {
  program: Program<SolanaDexContract>;
  requestId: string;
  requestIdBytes: number[];
  userAddress: string;
  type: TxType;
  derivePda: (requestIdBytes: number[]) => [PublicKey, number];
  fetchAccount: (pda: PublicKey) => Promise<T>;
  notFoundError: string;
  runRecovery: (account: T) => Promise<void>;
}): Promise<NextResponse> {
  const [pda] = params.derivePda(params.requestIdBytes);

  let account: T;
  try {
    account = await params.fetchAccount(pda);
  } catch {
    return NextResponse.json({ error: params.notFoundError }, { status: 404 });
  }

  if (account.requester.toBase58() !== params.userAddress) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  await registerTx(params.requestId, params.type, params.userAddress);

  after(async () => {
    try {
      await params.runRecovery(account);
    } catch (error) {
      console.error(`${params.type} recovery error:`, error);
    }
  });

  return NextResponse.json(
    { accepted: true, message: 'Recovery initiated' },
    { status: 202 },
  );
}

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

    const connection = new Connection(getAlchemySolanaDevnetRpcUrl(), 'confirmed');

    const keypair = getRelayerSolanaKeypair();
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
      return recoverPendingTx({
        program,
        requestId,
        requestIdBytes,
        userAddress,
        type: 'deposit',
        derivePda: derivePendingDepositPda,
        fetchAccount: (pda) => program.account.pendingErc20Deposit.fetch(pda),
        notFoundError: 'No pending deposit found',
        runRecovery: async (account) => {
          const result = await recoverDeposit(requestId, {
            requester: account.requester,
            erc20Address: account.erc20Address as number[],
          });
          if (!result.ok) {
            console.error('Deposit recovery failed:', result.error);
          } else {
            console.log('Deposit recovered successfully:', result.solanaTx);
          }
        },
      });
    }

    if (type === 'withdrawal') {
      if (!erc20Address) {
        return NextResponse.json(
          { error: 'Missing erc20Address for withdrawal recovery' },
          { status: 400 },
        );
      }

      return recoverPendingTx({
        program,
        requestId,
        requestIdBytes,
        userAddress,
        type: 'withdrawal',
        derivePda: derivePendingWithdrawalPda,
        fetchAccount: (pda) => program.account.pendingErc20Withdrawal.fetch(pda),
        notFoundError: 'No pending withdrawal found',
        runRecovery: async (account) => {
          const result = await recoverWithdrawal(
            requestId,
            { requester: account.requester.toBase58() },
            erc20Address,
          );
          if (!result.ok) {
            console.error('Withdrawal recovery failed:', result.error);
          } else {
            console.log('Withdrawal recovered successfully:', result.solanaTx);
          }
        },
      });
    }

    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
