import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { encodePacked, keccak256, type Hex } from 'viem';

import type {
  EvmTransactionRequest,
  EvmTransactionProgramParams,
} from '../types/shared.types';

/**
 * Generate a request ID matching the Rust implementation
 * This must match exactly with the contract's generate_sign_bidirectional_request_id function
 */
export function generateRequestId(
  sender: PublicKey,
  transactionData: Uint8Array,
  caip2Id: string,
  keyVersion: number,
  path: string,
  algo: string,
  dest: string,
  params: string,
): string {
  const txDataHex = ('0x' + Buffer.from(transactionData).toString('hex')) as Hex;

  const encoded = encodePacked(
    ['string', 'bytes', 'string', 'uint32', 'string', 'string', 'string', 'string'],
    [sender.toString(), txDataHex, caip2Id, keyVersion, path, algo, dest, params],
  );

  return keccak256(encoded);
}

/**
 * Convert EVM transaction params to the format expected by the Solana program
 */
export function evmParamsToProgram(
  params: Pick<
    EvmTransactionRequest,
    | 'value'
    | 'gasLimit'
    | 'maxFeePerGas'
    | 'maxPriorityFeePerGas'
    | 'nonce'
    | 'chainId'
  >,
): EvmTransactionProgramParams {
  return {
    value: new BN(params.value.toString()),
    gasLimit: new BN(params.gasLimit.toString()),
    maxFeePerGas: new BN(params.maxFeePerGas.toString()),
    maxPriorityFeePerGas: new BN(params.maxPriorityFeePerGas.toString()),
    nonce: new BN(params.nonce.toString()),
    chainId: new BN(params.chainId.toString()),
  };
}
