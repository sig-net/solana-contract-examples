import {
  encodeFunctionData,
  erc20Abi,
  parseGwei,
  serializeTransaction,
  type Hex,
  type PublicClient,
} from 'viem';

import { SERVICE_CONFIG } from '@/lib/constants/service.config';
import type { EvmTransactionRequest } from '@/lib/types/shared.types';

/**
 * Serialize an EVM transaction request to RLP-encoded bytes (without signature).
 * Used for generating request IDs before signing.
 */
export function serializeEvmTx(txRequest: EvmTransactionRequest): Hex {
  return serializeTransaction({
    chainId: txRequest.chainId,
    nonce: txRequest.nonce,
    maxPriorityFeePerGas: txRequest.maxPriorityFeePerGas,
    maxFeePerGas: txRequest.maxFeePerGas,
    gas: txRequest.gasLimit,
    to: txRequest.to,
    value: txRequest.value,
    data: txRequest.data,
  });
}

/**
 * Apply a random reduction to an amount to work around contract constraints.
 * This is a workaround for edge cases where the full amount causes issues.
 */
export function applyContractSafetyReduction(
  amount: bigint,
  range = 100,
): bigint {
  const reduction = BigInt(Math.floor(Math.random() * range) + 1);
  return amount > reduction ? amount - reduction : amount;
}

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
  const minPriorityFee = parseGwei('2');
  const estimatedPriorityFee = feeData.maxPriorityFeePerGas ?? parseGwei('3');
  const maxPriorityFeePerGas =
    estimatedPriorityFee > minPriorityFee ? estimatedPriorityFee : minPriorityFee;
  const baseMaxFeePerGas = feeData.maxFeePerGas ?? parseGwei('30');
  const maxFeePerGas = (baseMaxFeePerGas * 200n) / 100n; // 2x buffer for base fee volatility during MPC signing

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
