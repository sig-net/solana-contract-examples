import { PublicKey } from '@solana/web3.js';

import {
  deriveEthereumAddress,
  deriveVaultAuthorityPda,
} from '@/lib/constants/addresses';
import { notifyDeposit } from '@/lib/services/relayer-service';
import type { StatusCallback } from '@/lib/types/shared.types';
import { CHAIN_SIGNATURES_CONFIG } from '@/lib/constants/addresses';

export interface DepositResult {
  derivedAddress: string;
  trackingId: string;
}

/**
 * DepositService shows users where to deposit ERC20 tokens on Ethereum.
 * The relayer monitors Ethereum and handles Solana bridge calls automatically.
 */
export class DepositService {
  /**
   * Initiate an ERC20 deposit from Ethereum to Solana
   */
  async depositErc20(
    publicKey: PublicKey,
    erc20Address: string,
    amount: string,
    decimals = 6,
    tokenSymbol?: string,
    onStatusChange?: StatusCallback,
  ): Promise<DepositResult> {
    try {
      const [vaultAuthority] = deriveVaultAuthorityPda(publicKey);
      const path = publicKey.toString();
      const derivedAddress = deriveEthereumAddress(
        path,
        vaultAuthority.toString(),
        CHAIN_SIGNATURES_CONFIG.MPC_ROOT_PUBLIC_KEY,
      );

      // Notify relayer to monitor for this deposit
      const response = await notifyDeposit({
        userAddress: publicKey.toString(),
        erc20Address,
        ethereumAddress: derivedAddress,
        tokenDecimals: decimals,
        tokenSymbol,
      });

      onStatusChange?.({
        status: 'relayer_processing',
        note: `Deposit ${amount} tokens to: ${derivedAddress}. Relayer will handle the bridge process.`,
      });

      return {
        derivedAddress,
        trackingId: response.trackingId,
      };
    } catch (error) {
      console.error('Deposit ERC20 failed:', error);
      throw new Error(
        `Failed to initiate deposit: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
