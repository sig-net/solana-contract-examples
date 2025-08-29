import { PublicKey } from '@solana/web3.js';
import { ethers } from 'ethers';
import { secp256k1 } from '@noble/curves/secp256k1';

import { getClientEnv } from '@/lib/config/env.config';
import { IDL } from '@/lib/program/idl-sol-dex';

// Get environment variables
const env = getClientEnv();

/**
 * The deployed Solana program ID
 * Reads directly from the IDL to ensure it's always in sync
 */
export const BRIDGE_PROGRAM_ID = new PublicKey(IDL.address);

export const CHAIN_SIGNATURES_PROGRAM_ID = new PublicKey(
  env.NEXT_PUBLIC_CHAIN_SIGNATURES_PROGRAM_ID,
);

/**
 * Chain Signatures MPC configuration
 */
export const CHAIN_SIGNATURES_CONFIG = {
  BASE_PUBLIC_KEY: env.NEXT_PUBLIC_BASE_PUBLIC_KEY,
  EPSILON_DERIVATION_PREFIX: 'sig.network v1.0.0 epsilon derivation',
  SOLANA_CHAIN_ID: '0x800001f5',
} as const;

export const RESPONDER_ADDRESS = env.NEXT_PUBLIC_RESPONDER_ADDRESS;

/**
 * MPC Root Signer Address - derived directly from base public key
 * This address stays constant across deployments
 */
export const MPC_ROOT_SIGNER_ADDRESS = ethers.computeAddress(
  CHAIN_SIGNATURES_CONFIG.BASE_PUBLIC_KEY,
);

/**
 * Seeds for Program Derived Addresses (PDAs)
 */
export const BRIDGE_PDA_SEEDS = {
  VAULT_AUTHORITY: 'vault_authority',
  GLOBAL_VAULT_AUTHORITY: 'global_vault_authority',
  PENDING_ERC20_DEPOSIT: 'pending_erc20_deposit',
  PENDING_ERC20_WITHDRAWAL: 'pending_erc20_withdrawal',
  USER_ERC20_BALANCE: 'user_erc20_balance',
  USER_TRANSACTION_HISTORY: 'user_transaction_history',
  PROGRAM_STATE: 'program-state',
} as const;

/**
 * Centralized PDA derivation helpers
 */
export function deriveVaultAuthorityPda(
  userPublicKey: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BRIDGE_PDA_SEEDS.VAULT_AUTHORITY), userPublicKey.toBuffer()],
    BRIDGE_PROGRAM_ID,
  );
}

export function derivePendingDepositPda(
  requestIdBytes: number[],
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(BRIDGE_PDA_SEEDS.PENDING_ERC20_DEPOSIT),
      Buffer.from(requestIdBytes),
    ],
    BRIDGE_PROGRAM_ID,
  );
}

export function derivePendingWithdrawalPda(
  requestIdBytes: number[],
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(BRIDGE_PDA_SEEDS.PENDING_ERC20_WITHDRAWAL),
      Buffer.from(requestIdBytes),
    ],
    BRIDGE_PROGRAM_ID,
  );
}

export function deriveUserBalancePda(
  userPublicKey: PublicKey,
  erc20AddressBytes: Buffer,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(BRIDGE_PDA_SEEDS.USER_ERC20_BALANCE),
      userPublicKey.toBuffer(),
      erc20AddressBytes,
    ],
    BRIDGE_PROGRAM_ID,
  );
}

export function deriveUserTransactionHistoryPda(
  userPublicKey: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(BRIDGE_PDA_SEEDS.USER_TRANSACTION_HISTORY),
      userPublicKey.toBuffer(),
    ],
    BRIDGE_PROGRAM_ID,
  );
}

export function deriveChainSignaturesStatePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BRIDGE_PDA_SEEDS.PROGRAM_STATE)],
    CHAIN_SIGNATURES_PROGRAM_ID,
  );
}

/**
 * Derive epsilon value for key derivation
 */
function deriveEpsilon(requester: string, path: string): bigint {
  const derivationPath = `${CHAIN_SIGNATURES_CONFIG.EPSILON_DERIVATION_PREFIX},${CHAIN_SIGNATURES_CONFIG.SOLANA_CHAIN_ID},${requester},${path}`;
  const hash = ethers.keccak256(ethers.toUtf8Bytes(derivationPath));
  return BigInt(hash);
}

/**
 * Convert public key string to elliptic curve point
 */
function publicKeyToPoint(publicKey: string): { x: bigint; y: bigint } {
  const cleanPubKey = publicKey.slice(4);
  const x = cleanPubKey.slice(0, 64);
  const y = cleanPubKey.slice(64, 128);
  return {
    x: BigInt('0x' + x),
    y: BigInt('0x' + y),
  };
}

/**
 * Convert elliptic curve point to public key string
 */
function pointToPublicKey(point: { x: bigint; y: bigint }): string {
  const x = point.x.toString(16).padStart(64, '0');
  const y = point.y.toString(16).padStart(64, '0');
  return '0x04' + x + y;
}

/**
 * Derive public key using epsilon and base public key
 */
function derivePublicKey(
  path: string,
  requesterAddress: string,
  basePublicKey: string,
): string {
  try {
    const epsilon = deriveEpsilon(requesterAddress, path);
    const basePoint = publicKeyToPoint(basePublicKey);

    const epsilonPoint = secp256k1.ProjectivePoint.BASE.multiply(epsilon);

    const baseProjectivePoint = new secp256k1.ProjectivePoint(
      basePoint.x,
      basePoint.y,
      BigInt(1),
    );

    const resultPoint = epsilonPoint.add(baseProjectivePoint);
    const resultAffine = resultPoint.toAffine();

    return pointToPublicKey({
      x: resultAffine.x,
      y: resultAffine.y,
    });
  } catch (error) {
    throw new Error(
      `Key derivation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Derive Ethereum address from public key and path
 */
export function deriveEthereumAddress(
  path: string,
  requesterAddress: string,
  basePublicKey: string,
): string {
  const derivedPublicKey = derivePublicKey(
    path,
    requesterAddress,
    basePublicKey,
  );
  return ethers.computeAddress(derivedPublicKey);
}

/**
 * Global Vault Authority PDA - used for withdrawals
 */
export const GLOBAL_VAULT_AUTHORITY_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from(BRIDGE_PDA_SEEDS.GLOBAL_VAULT_AUTHORITY)],
  BRIDGE_PROGRAM_ID,
)[0];

/**
 * Global Vault Ethereum Address
 * This is the main vault address where all deposits go and withdrawals come from
 * Derived programmatically from the global vault authority PDA
 */
export const VAULT_ETHEREUM_ADDRESS = (() => {
  try {
    const derivedPublicKey = derivePublicKey(
      'root',
      GLOBAL_VAULT_AUTHORITY_PDA.toString(),
      CHAIN_SIGNATURES_CONFIG.BASE_PUBLIC_KEY,
    );
    return ethers.computeAddress(derivedPublicKey);
  } catch (error) {
    throw new Error(
      `Failed to derive vault address: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
})();
