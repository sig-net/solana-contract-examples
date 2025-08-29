import { Buffer } from 'buffer';

import {
  Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';
import { Program, AnchorProvider, BN, Wallet } from '@coral-xyz/anchor';
import { toHex, toBytes } from 'viem';

import { IDL, type SolDexIDL } from '@/lib/program/idl-sol-dex';
import type { EvmTransactionProgramParams } from '@/lib/types/shared.types';
import {
  deriveEthereumAddress,
  CHAIN_SIGNATURES_CONFIG,
  deriveVaultAuthorityPda,
  deriveUserBalancePda,
  deriveUserTransactionHistoryPda,
} from '@/lib/constants/addresses';

import { ChainSignaturesSignature } from '../types/chain-signatures.types';

type TransactionStatus =
  | { pending: Record<string, never> }
  | { completed: Record<string, never> }
  | { failed: Record<string, never> };

type TransactionRecord = {
  requestId: number[];
  transactionType:
    | { deposit: Record<string, never> }
    | { withdrawal: Record<string, never> };
  status: TransactionStatus;
  amount: BN;
  erc20Address: number[];
  recipientAddress: number[];
  timestamp: BN;
  ethereumTxHash: number[] | null;
};

type UserTransactionHistory = {
  deposits: TransactionRecord[];
  withdrawals: TransactionRecord[];
};

export class BridgeContract {
  private program: Program<SolDexIDL> | null = null;

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

  private getBridgeProgram(): Program<SolDexIDL> {
    if (!this.program) {
      const provider = new AnchorProvider(this.connection, this.wallet, {
        commitment: 'confirmed',
        skipPreflight: true,
      });
      this.program = new Program(IDL as any, provider) as Program<SolDexIDL>;
    }
    return this.program;
  }

  async fetchPendingDeposit(pendingDepositPda: PublicKey) {
    return await this.getBridgeProgram().account.pendingErc20Deposit.fetch(
      pendingDepositPda,
    );
  }

  async fetchUserBalance(
    userPublicKey: PublicKey,
    erc20Address: string,
  ): Promise<string> {
    try {
      const erc20Bytes = Buffer.from(toBytes(erc20Address as `0x${string}`));
      const [userBalancePda] = deriveUserBalancePda(userPublicKey, erc20Bytes);

      const userBalanceAccount =
        await this.getBridgeProgram().account.userErc20Balance.fetchNullable(
          userBalancePda,
        );

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
    const program = this.getBridgeProgram();

    return await program.methods
      .depositErc20(
        requestIdBytes,
        requester,
        erc20AddressBytes,
        recipientAddressBytes,
        amount,
        evmParams,
      )
      .accounts({
        payer: payerKey,
        feePayer: payerKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
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
    const [transactionHistory] = deriveUserTransactionHistoryPda(requester);
    const program = this.getBridgeProgram();

    return await program.methods
      .claimErc20(
        Array.from(requestIdBytes),
        serializedOutput,
        signature,
        ethereumTxHashBytes ? Array.from(ethereumTxHashBytes) : null,
      )
      .accounts({
        userBalance: userBalancePda,
        transactionHistory,
      } as never)
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
    const program = this.getBridgeProgram();

    return await program.methods
      .withdrawErc20(
        Array.from(requestIdBytes),
        Array.from(erc20AddressBytes),
        amount,
        Array.from(recipientAddressBytes),
        evmParams,
      )
      .accounts({
        authority,
        feePayer: this.wallet.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();
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
    const [transactionHistory] = deriveUserTransactionHistoryPda(requester);
    const program = this.getBridgeProgram();

    return await program.methods
      .completeWithdrawErc20(
        Array.from(requestIdBytes),
        serializedOutput,
        signature,
        ethereumTxHashBytes ? Array.from(ethereumTxHashBytes) : null,
      )
      .accounts({
        userBalance: userBalancePda,
        transactionHistory,
      } as never)
      .rpc();
  }

  async fetchPendingWithdrawal(
    pendingWithdrawalPda: PublicKey,
  ): Promise<unknown> {
    return await this.getBridgeProgram().account.pendingErc20Withdrawal.fetch(
      pendingWithdrawalPda,
    );
  }

  async fetchAllUserWithdrawals(userPublicKey: PublicKey): Promise<
    {
      requestId: string;
      amount: string;
      erc20Address: string;
      recipient: string;
      status: 'pending' | 'completed';
      timestamp: number;
      signature?: string;
      ethereumTxHash?: string;
    }[]
  > {
    try {
      const program = this.getBridgeProgram();
      const [userTransactionHistoryPda] =
        deriveUserTransactionHistoryPda(userPublicKey);

      const transactionHistory =
        (await program.account.userTransactionHistory.fetchNullable(
          userTransactionHistoryPda,
        )) as UserTransactionHistory | null;

      if (!transactionHistory) {
        return [];
      }

      const withdrawals = transactionHistory.withdrawals.map(
        (withdrawal: TransactionRecord) => ({
          requestId: toHex(Buffer.from(withdrawal.requestId)),
          amount: withdrawal.amount.toString(),
          erc20Address: toHex(Buffer.from(withdrawal.erc20Address)),
          recipient: toHex(Buffer.from(withdrawal.recipientAddress)),
          status:
            'pending' in withdrawal.status
              ? ('pending' as const)
              : 'failed' in withdrawal.status
                ? ('pending' as const)
                : ('completed' as const),
          timestamp: withdrawal.timestamp.toNumber(),
          signature: undefined,
          ethereumTxHash: withdrawal.ethereumTxHash
            ? toHex(Buffer.from(withdrawal.ethereumTxHash))
            : undefined,
        }),
      );

      return withdrawals.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error(
        'Error fetching user withdrawals from transaction history:',
        error,
      );
      return [];
    }
  }

  deriveDepositAddress(publicKey: PublicKey): string {
    const [vaultAuthority] = deriveVaultAuthorityPda(publicKey);
    const path = publicKey.toString();
    return deriveEthereumAddress(
      path,
      vaultAuthority.toString(),
      CHAIN_SIGNATURES_CONFIG.BASE_PUBLIC_KEY,
    );
  }

  async fetchAllUserDeposits(userPublicKey: PublicKey): Promise<
    {
      requestId: string;
      amount: string;
      erc20Address: string;
      timestamp: number;
      status: 'pending' | 'completed';
      ethereumTxHash?: string;
    }[]
  > {
    try {
      const program = this.getBridgeProgram();
      const [userTransactionHistoryPda] =
        deriveUserTransactionHistoryPda(userPublicKey);

      const transactionHistory =
        (await program.account.userTransactionHistory.fetchNullable(
          userTransactionHistoryPda,
        )) as UserTransactionHistory | null;

      if (!transactionHistory) {
        return [];
      }

      const deposits = transactionHistory.deposits.map(
        (deposit: TransactionRecord) => ({
          requestId: toHex(Buffer.from(deposit.requestId)),
          amount: deposit.amount.toString(),
          erc20Address: toHex(Buffer.from(deposit.erc20Address)),
          timestamp: deposit.timestamp.toNumber(),
          status:
            'pending' in deposit.status
              ? ('pending' as const)
              : 'failed' in deposit.status
                ? ('pending' as const)
                : ('completed' as const),
          ethereumTxHash: deposit.ethereumTxHash
            ? toHex(Buffer.from(deposit.ethereumTxHash))
            : undefined,
        }),
      );

      return deposits.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error(
        'Error fetching user deposits from transaction history:',
        error,
      );
      return [];
    }
  }
}
