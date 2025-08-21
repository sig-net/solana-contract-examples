import { NextRequest, NextResponse } from 'next/server';

import { handleWithdrawal } from '@/lib/relayer/handlers';
import type { EvmTransactionRequest } from '@/lib/types/shared.types';

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

    handleWithdrawal({
      requestId,
      erc20Address,
      transactionParams: transactionParams as EvmTransactionRequest,
    })
      .then(result => {
        if (!result.ok) {
          console.error('Withdrawal processing failed:', result.error);
        } else {
          console.log('Withdrawal processed successfully:', result.requestId);
        }
      })
      .catch(error => {
        console.error('Withdrawal processing error:', error);
      });

    return NextResponse.json({ accepted: true }, { status: 202 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
