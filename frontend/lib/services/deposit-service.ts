import { PublicKey } from '@solana/web3.js';

import {
  deriveEthereumAddress,
  deriveVaultAuthorityPda,
} from '@/lib/constants/addresses';
import { notifyDeposit } from '@/lib/services/relayer-service';
import type { StatusCallback } from '@/lib/types/shared.types';
import { CHAIN_SIGNATURES_CONFIG } from '@/lib/constants/addresses';

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
    _decimals = 6,
    onStatusChange?: StatusCallback,
  ): Promise<string> {
    try {
      const [vaultAuthority] = deriveVaultAuthorityPda(publicKey);
      const path = publicKey.toString();
      const derivedAddress = deriveEthereumAddress(
        path,
        vaultAuthority.toString(),
        CHAIN_SIGNATURES_CONFIG.MPC_ROOT_PUBLIC_KEY,
      );

      // Notify relayer to monitor for this deposit
      await notifyDeposit({
        userAddress: publicKey.toString(),
        erc20Address,
        ethereumAddress: derivedAddress,
      });

      onStatusChange?.({
        status: 'relayer_processing',
        note: `Deposit ${amount} tokens to: ${derivedAddress}. Relayer will handle the bridge process.`,
      });

      // Return the derived address as the "request ID" for tracking
      return derivedAddress;
    } catch (error) {
      console.error('Deposit ERC20 failed:', error);
      throw new Error(
        `Failed to initiate deposit: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
