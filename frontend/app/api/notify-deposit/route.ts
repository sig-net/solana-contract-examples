import { NextRequest, NextResponse } from 'next/server';

import { handleDeposit } from '@/lib/relayer/handlers';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userAddress, erc20Address, ethereumAddress } = body;

    if (!userAddress || !erc20Address || !ethereumAddress) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 },
      );
    }

    handleDeposit({
      userAddress,
      erc20Address,
      ethereumAddress,
    })
      .then(result => {
        if (!result.ok) {
          console.error('Deposit processing failed:', result.error);
        } else {
          console.log('Deposit processed successfully:', result.requestId);
        }
      })
      .catch(error => {
        console.error('Deposit processing error:', error);
      });

    return NextResponse.json({ accepted: true }, { status: 202 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
