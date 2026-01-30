import { Buffer } from 'buffer';

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  type TransactionSignature,
} from '@solana/web3.js';
import { Program, AnchorProvider, BN, Wallet } from '@coral-xyz/anchor';
import { toBytes } from 'viem';

import { IDL, type SolanaDexContract } from '@/lib/program/idl-sol-dex';
import type { EvmTransactionProgramParams } from '@/lib/types/shared.types';
import {
  deriveEthereumAddress,
  CHAIN_SIGNATURES_CONFIG,
  deriveVaultAuthorityPda,
  deriveUserBalancePda,
  derivePendingDepositPda,
  derivePendingWithdrawalPda,
} from '@/lib/constants/addresses';

import type { RSVSignature } from 'signet.js';

const COMPUTE_UNITS_FOR_DERIVATION = 400_000;
const PRIORITY_FEE_MICRO_LAMPORTS = 50_000;

export class DexContract {
  private program: Program<SolanaDexContract> | null = null;

  constructor(
    private connection: Connection,
    private wallet: Wallet,
  ) {}

  getConnection(): Connection {
    return this.connection;
  }

  getWallet(): Wallet {
    return this.wallet;
  }

  private getDexProgram(): Program<SolanaDexContract> {
    if (!this.program) {
      const provider = new AnchorProvider(this.connection, this.wallet, {
        commitment: 'confirmed',
        skipPreflight: true,
      });
      this.program = new Program(IDL, provider);
    }
    return this.program;
  }

  async fetchPendingDeposit(pendingDepositPda: PublicKey) {
    const program = this.getDexProgram();
    return program.account.pendingErc20Deposit.fetch(pendingDepositPda);
  }

  async fetchUserBalance(
    userPublicKey: PublicKey,
    erc20Address: string,
  ): Promise<string> {
    try {
      const erc20Bytes = Buffer.from(toBytes(erc20Address as `0x${string}`));
      const [userBalancePda] = deriveUserBalancePda(userPublicKey, erc20Bytes);
      const program = this.getDexProgram();

      const userBalanceAccount =
        await program.account.userErc20Balance.fetchNullable(userBalancePda);

      if (!userBalanceAccount) {
        return '0';
      }

      return userBalanceAccount.amount.toString();
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('Account does not exist') ||
          error.message.includes('AccountNotFound'))
      ) {
        return '0';
      }
      throw new Error(
        `Failed to fetch user balance: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async depositErc20({
    requester,
    payer,
    requestIdBytes,
    erc20AddressBytes,
    recipientAddressBytes,
    amount,
    evmParams,
  }: {
    requester: PublicKey;
    payer?: PublicKey;
    requestIdBytes: number[];
    erc20AddressBytes: number[];
    recipientAddressBytes: number[];
    amount: BN;
    evmParams: EvmTransactionProgramParams;
  }): Promise<string> {
    const payerKey = payer || this.wallet.publicKey;
    const program = this.getDexProgram();

    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('confirmed');

    // Explicitly derive PDA to ensure consistency with fetch operations
    const [pendingDepositPda] = derivePendingDepositPda(requestIdBytes);

    console.log(`[DEPOSIT] Creating PendingDeposit at PDA: ${pendingDepositPda.toBase58()}`);

    const signature = await program.methods
      .depositErc20(
        requestIdBytes as unknown as number[],
        requester,
        erc20AddressBytes as unknown as number[],
        recipientAddressBytes as unknown as number[],
        amount,
        evmParams,
      )
      .accountsPartial({
        payer: payerKey,
        pendingDeposit: pendingDepositPda,
        feePayer: payerKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({
          units: COMPUTE_UNITS_FOR_DERIVATION,
        }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: PRIORITY_FEE_MICRO_LAMPORTS,
        }),
      ])
      .rpc();

    console.log(`[DEPOSIT] Solana tx submitted: ${signature}`);

    await this.confirmTransactionOrThrow(signature, blockhash, lastValidBlockHeight, 'DEPOSIT');

    return signature;
  }

  async claimErc20({
    requestIdBytes,
    serializedOutput,
    signature,
    erc20AddressBytes,
    requester,
    ethereumTxHashBytes,
  }: {
    requestIdBytes: number[];
    serializedOutput: Buffer | number[];
    signature: RSVSignature;
    erc20AddressBytes: number[];
    requester: PublicKey;
    ethereumTxHashBytes?: number[];
  }): Promise<string> {
    const erc20Bytes = Buffer.from(erc20AddressBytes);
    const [userBalancePda] = deriveUserBalancePda(requester, erc20Bytes);
    const program = this.getDexProgram();

    return await program.methods
      .claimErc20(
        Array.from(requestIdBytes) as unknown as number[],
        Buffer.from(serializedOutput),
        signature,
        ethereumTxHashBytes
          ? (Array.from(ethereumTxHashBytes) as unknown as number[])
          : null,
      )
      .accounts({
        userBalance: userBalancePda,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({
          units: COMPUTE_UNITS_FOR_DERIVATION,
        }),
      ])
      .rpc();
  }

  async withdrawErc20({
    authority,
    requestIdBytes,
    erc20AddressBytes,
    amount,
    recipientAddressBytes,
    evmParams,
  }: {
    authority: PublicKey;
    requestIdBytes: number[];
    erc20AddressBytes: number[];
    amount: BN;
    recipientAddressBytes: number[];
    evmParams: EvmTransactionProgramParams;
  }): Promise<{
    signature: string;
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    const program = this.getDexProgram();

    // Explicitly derive PDA to ensure consistency with fetch operations
    const [pendingWithdrawalPda] = derivePendingWithdrawalPda(requestIdBytes);

    console.log(`[WITHDRAW] Creating PendingWithdrawal at PDA: ${pendingWithdrawalPda.toBase58()}`);

    const tx = await program.methods
      .withdrawErc20(
        Array.from(requestIdBytes) as unknown as number[],
        Array.from(erc20AddressBytes) as unknown as number[],
        amount,
        Array.from(recipientAddressBytes) as unknown as number[],
        evmParams,
      )
      .accountsPartial({
        authority,
        pendingWithdrawal: pendingWithdrawalPda,
        feePayer: authority,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({
          units: COMPUTE_UNITS_FOR_DERIVATION,
        }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: PRIORITY_FEE_MICRO_LAMPORTS,
        }),
      ])
      .transaction();

    tx.feePayer = authority;
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;

    const signedTx = await this.wallet.signTransaction(tx);

    const signature = await this.connection.sendRawTransaction(
      signedTx.serialize(),
      { skipPreflight: true },
    );

    console.log(`[WITHDRAW] Solana tx submitted: ${signature}`);

    // Return immediately - confirmation happens in the background handler
    return { signature, blockhash, lastValidBlockHeight };
  }

  async completeWithdrawErc20({
    requestIdBytes,
    serializedOutput,
    signature,
    erc20AddressBytes,
    requester,
    ethereumTxHashBytes,
  }: {
    requestIdBytes: number[];
    serializedOutput: Buffer | number[];
    signature: RSVSignature;
    erc20AddressBytes: number[];
    requester: PublicKey;
    ethereumTxHashBytes?: number[];
  }): Promise<string> {
    const erc20Bytes = Buffer.from(erc20AddressBytes);
    const [userBalancePda] = deriveUserBalancePda(requester, erc20Bytes);
    const program = this.getDexProgram();

    return await program.methods
      .completeWithdrawErc20(
        Array.from(requestIdBytes) as unknown as number[],
        Buffer.from(serializedOutput),
        signature,
        ethereumTxHashBytes
          ? (Array.from(ethereumTxHashBytes) as unknown as number[])
          : null,
      )
      .accounts({
        userBalance: userBalancePda,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({
          units: COMPUTE_UNITS_FOR_DERIVATION,
        }),
      ])
      .rpc();
  }

  async fetchPendingWithdrawal(pendingWithdrawalPda: PublicKey) {
    const program = this.getDexProgram();
    return program.account.pendingErc20Withdrawal.fetch(pendingWithdrawalPda);
  }

  deriveDepositAddress(publicKey: PublicKey): string {
    const [vaultAuthority] = deriveVaultAuthorityPda(publicKey);
    const path = publicKey.toString();
    return deriveEthereumAddress(
      path,
      vaultAuthority.toString(),
      CHAIN_SIGNATURES_CONFIG.MPC_ROOT_PUBLIC_KEY,
    );
  }

  /**
   * Confirms a transaction with proper handling of blockhash expiration.
   * When blockhash expires, checks status once - if not landed, it never will.
   */
  async confirmTransactionOrThrow(
    signature: TransactionSignature,
    blockhash: string,
    lastValidBlockHeight: number,
    logPrefix: string,
  ): Promise<void> {
    console.log(`[${logPrefix}] Waiting for confirmation...`);

    try {
      const result = await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );

      if (result.value.err) {
        console.error(`[${logPrefix}] Transaction failed:`, result.value.err);
        throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
      }

      console.log(`[${logPrefix}] Transaction confirmed: ${signature}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Blockhash expired - check final status once
      if (
        errorMessage.includes('block height exceeded') ||
        errorMessage.includes('expired')
      ) {
        console.log(`[${logPrefix}] Blockhash expired, checking final status...`);
        const response = await this.connection.getSignatureStatuses([signature]);
        const status = response.value[0];

        if (status) {
          if (status.err) {
            console.error(`[${logPrefix}] Transaction failed:`, status.err);
            throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
          }

          if (
            status.confirmationStatus === 'confirmed' ||
            status.confirmationStatus === 'finalized'
          ) {
            console.log(`[${logPrefix}] Transaction confirmed (post-expiry): ${signature}`);
            return;
          }
        }

        // Blockhash expired and tx not found - it will never land
        throw new Error(
          `Transaction not confirmed: blockhash expired and transaction not found. Signature: ${signature}`,
        );
      }

      console.error(`[${logPrefix}] Confirmation error:`, error);
      throw error;
    }
  }
}
