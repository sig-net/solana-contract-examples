import { PublicKey } from '@solana/web3.js';
import { toBytes } from 'viem';

import { generateRequestId } from '@/lib/program/utils';
import { SERVICE_CONFIG } from '@/lib/constants/service.config';

/**
 * Generate a request ID for deposit operations.
 * Uses the user's address as the derivation path.
 */
export function generateDepositRequestId(
  vaultAuthority: PublicKey,
  userPath: string,
  rlpEncodedTx: string,
): string {
  return generateRequestId(
    vaultAuthority,
    toBytes(rlpEncodedTx),
    SERVICE_CONFIG.ETHEREUM.CAIP2_ID,
    SERVICE_CONFIG.RETRY.DEFAULT_KEY_VERSION,
    userPath,
    SERVICE_CONFIG.CRYPTOGRAPHY.SIGNATURE_ALGORITHM,
    SERVICE_CONFIG.CRYPTOGRAPHY.TARGET_BLOCKCHAIN,
    '',
  );
}

/**
 * Generate a request ID for withdrawal operations.
 * Uses the global withdrawal root path.
 */
export function generateWithdrawalRequestId(
  globalVaultAuthority: PublicKey,
  rlpEncodedTx: string,
): string {
  return generateRequestId(
    globalVaultAuthority,
    toBytes(rlpEncodedTx),
    SERVICE_CONFIG.ETHEREUM.CAIP2_ID,
    SERVICE_CONFIG.RETRY.DEFAULT_KEY_VERSION,
    SERVICE_CONFIG.CRYPTOGRAPHY.WITHDRAWAL_ROOT_PATH,
    SERVICE_CONFIG.CRYPTOGRAPHY.SIGNATURE_ALGORITHM,
    SERVICE_CONFIG.CRYPTOGRAPHY.TARGET_BLOCKCHAIN,
    '',
  );
}
