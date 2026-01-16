import {
  encodeFunctionData,
  erc20Abi,
  parseGwei,
  type Hex,
  type PublicClient,
} from 'viem';

import { SERVICE_CONFIG } from '@/lib/constants/service.config';
import type { EvmTransactionRequest } from '@/lib/types/shared.types';

export function encodeErc20Transfer(recipient: string, amount: bigint): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [recipient as Hex, amount],
  });
}

export async function buildErc20TransferTx(params: {
  provider: PublicClient;
  from: string;
  erc20Address: string;
  recipient: string;
  amount: bigint;
}): Promise<EvmTransactionRequest> {
  const { provider, from, erc20Address, recipient, amount } = params;

  const nonce = await provider.getTransactionCount({ address: from as Hex });

  const data = encodeErc20Transfer(recipient, amount);

  const estimatedGas = await provider.estimateGas({
    account: from as Hex,
    to: erc20Address as Hex,
    data,
    value: BigInt(0),
  });
  const gasLimit = (estimatedGas * BigInt(120)) / BigInt(100); // 20% buffer

  const feeData = await provider.estimateFeesPerGas();
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? parseGwei('2');
  const maxFeePerGas = feeData.maxFeePerGas ?? parseGwei('20');

  const txRequest: EvmTransactionRequest = {
    type: 2,
    chainId: SERVICE_CONFIG.ETHEREUM.CHAIN_ID,
    nonce,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasLimit,
    to: erc20Address as Hex,
    value: BigInt(0),
    data,
  };

  return txRequest;
}
