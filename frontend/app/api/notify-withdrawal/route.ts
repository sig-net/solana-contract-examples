import { after } from 'next/server';
import { NextRequest, NextResponse } from 'next/server';

import { handleWithdrawal } from '@/lib/relayer/handlers';
import type {
  EvmTransactionRequest,
  EvmTransactionRequestNotifyWithdrawal,
} from '@/lib/types/shared.types';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function parseTransactionParams(
  params: EvmTransactionRequestNotifyWithdrawal,
): EvmTransactionRequest {
  return {
    type: params.type,
    chainId: params.chainId,
    nonce: params.nonce,
    to: params.to,
    data: params.data,
    value: BigInt(params.value),
    gasLimit: BigInt(params.gasLimit),
    maxFeePerGas: BigInt(params.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(params.maxPriorityFeePerGas),
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { requestId, erc20Address, transactionParams } = body;

    if (!requestId || !erc20Address || !transactionParams) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 },
      );
    }

    after(async () => {
      try {
        const result = await handleWithdrawal({
          requestId,
          erc20Address,
          transactionParams: parseTransactionParams(transactionParams),
        });
        if (!result.ok) {
          console.error('Withdrawal processing failed:', result.error);
        } else {
          console.log('Withdrawal processed successfully:', result.requestId);
        }
      } catch (error) {
        console.error('Withdrawal processing error:', error);
      }
    });

    return NextResponse.json({ accepted: true }, { status: 202 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
