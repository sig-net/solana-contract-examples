import { Buffer } from 'buffer';

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
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
} from '@/lib/constants/addresses';

import { ChainSignaturesSignature } from '../types/chain-signatures.types';

const COMPUTE_UNITS_FOR_DERIVATION = 400_000;

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

    return await program.methods
      .depositErc20(
        requestIdBytes as unknown as number[],
        requester,
        erc20AddressBytes as unknown as number[],
        recipientAddressBytes as unknown as number[],
        amount,
        evmParams,
      )
      .accounts({
        payer: payerKey,
        feePayer: payerKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({
          units: COMPUTE_UNITS_FOR_DERIVATION,
        }),
      ])
      .rpc();
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
    serializedOutput: number[];
    signature: ChainSignaturesSignature;
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
  }): Promise<string> {
    const program = this.getDexProgram();

    const tx = await program.methods
      .withdrawErc20(
        Array.from(requestIdBytes) as unknown as number[],
        Array.from(erc20AddressBytes) as unknown as number[],
        amount,
        Array.from(recipientAddressBytes) as unknown as number[],
        evmParams,
      )
      .accounts({
        authority,
        feePayer: authority,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({
          units: COMPUTE_UNITS_FOR_DERIVATION,
        }),
      ])
      .transaction();

    tx.feePayer = authority;
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    const signedTx = await this.wallet.signTransaction(tx);

    const signature = await this.connection.sendRawTransaction(
      signedTx.serialize(),
      { skipPreflight: true },
    );

    return signature;
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
    serializedOutput: number[];
    signature: ChainSignaturesSignature;
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
}
