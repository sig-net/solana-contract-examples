import { Buffer } from 'buffer';

import {
  Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  type ConfirmedSignatureInfo,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { Program, AnchorProvider, BN, Wallet } from '@coral-xyz/anchor';

import { IDL, type SolanaCoreContracts } from '@/lib/program/idl-sol-dex';
import type { EvmTransactionProgramParams } from '@/lib/types/shared.types';
import {
  BRIDGE_PROGRAM_ID,
  deriveEthereumAddress,
  CHAIN_SIGNATURES_CONFIG,
  deriveVaultAuthorityPda,
  deriveUserBalancePda,
} from '@/lib/constants/addresses';
import { getAllErc20Tokens } from '@/lib/constants/token-metadata';
import {
  cachedGetSignaturesForAddress,
  cachedGetTransaction,
} from '@/lib/utils/rpc-cache';

import { ChainSignaturesSignature } from '../types/chain-signatures.types';

/**
 * BridgeContract class handles all low-level contract interactions,
 * PDA derivations, and account management for the cross-chain wallet program.
 */
export class BridgeContract {
  private program: Program<SolanaCoreContracts> | null = null;

  constructor(
    private connection: Connection,
    private wallet: Wallet,
  ) {}

  /**
   * Expose the underlying Solana connection for consumers that need direct RPC access
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Expose the wallet used by the BridgeContract for signing transactions
   */
  getWallet(): Wallet {
    return this.wallet;
  }

  /**
   * Get the core contracts program instance
   */
  private getBridgeProgram(): Program<SolanaCoreContracts> {
    if (!this.program) {
      const provider = new AnchorProvider(this.connection, this.wallet, {
        commitment: 'confirmed',
        skipPreflight: true, // Skip preflight to avoid duplicate transaction errors
      });
      this.program = new Program(IDL, provider) as Program<SolanaCoreContracts>;
    }
    return this.program;
  }

  // ================================
  // PDA Derivation Methods
  // ================================

  // Removed one-line PDA wrappers; call centralized helpers directly where needed

  // ================================
  // Account Fetching Methods
  // ================================

  /**
   * Fetch pending deposit account data
   */
  async fetchPendingDeposit(pendingDepositPda: PublicKey) {
    return await this.getBridgeProgram().account.pendingErc20Deposit.fetch(
      pendingDepositPda,
    );
  }

  /**
   * Fetch user balance for a specific ERC20 token using Anchor deserialization
   */
  async fetchUserBalance(
    userPublicKey: PublicKey,
    erc20Address: string,
  ): Promise<string> {
    try {
      const erc20Bytes = Buffer.from(erc20Address.replace('0x', ''), 'hex');
      const [userBalancePda] = deriveUserBalancePda(userPublicKey, erc20Bytes);

      // Use Anchor's account fetching mechanism instead of manual parsing
      const userBalanceAccount =
        await this.getBridgeProgram().account.userErc20Balance.fetchNullable(
          userBalancePda,
        );

      if (!userBalanceAccount) {
        return '0';
      }

      // Access the amount field directly from the deserialized account
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

  // ================================
  // Contract Method Calls
  // ================================

  /**
   * Call depositErc20 method with all accounts prepared
   */
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

    const [transactionHistory] = PublicKey.findProgramAddressSync(
      [Buffer.from('user_transaction_history'), requester.toBuffer()],
      program.programId,
    );

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
        transactionHistory,
      })
      .rpc();
  }

  /**
   * Call claimErc20 method with all accounts prepared
   */
  async claimErc20({
    payer: _payer,
    requestIdBytes,
    serializedOutput,
    signature,
    erc20AddressBytes,
    requester,
  }: {
    payer?: PublicKey;
    requestIdBytes: number[];
    serializedOutput: number[];
    signature: ChainSignaturesSignature;
    erc20AddressBytes: number[];
    requester: PublicKey;
  }): Promise<string> {
    const erc20Bytes = Buffer.from(erc20AddressBytes);
    const [userBalancePda] = deriveUserBalancePda(requester, erc20Bytes);
    const program = this.getBridgeProgram();

    // Derive transaction history PDA (from pending_deposit.requester which is the requester param)
    const [transactionHistory] = PublicKey.findProgramAddressSync(
      [Buffer.from('user_transaction_history'), requester.toBuffer()],
      program.programId,
    );

    return await program.methods
      .claimErc20(Array.from(requestIdBytes), serializedOutput, signature)
      .accounts({
        userBalance: userBalancePda,
        transactionHistory,
      })
      .rpc();
  }

  /**
   * Initiate ERC20 withdrawal
   */
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

    // Derive transaction history PDA from authority
    const [transactionHistory] = PublicKey.findProgramAddressSync(
      [Buffer.from('user_transaction_history'), authority.toBuffer()],
      program.programId,
    );

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
        transactionHistory,
      })
      .rpc();
  }

  /**
   * Complete ERC20 withdrawal
   */
  async completeWithdrawErc20({
    payer: _payer,
    requestIdBytes,
    serializedOutput,
    signature,
    erc20AddressBytes,
    requester,
  }: {
    payer?: PublicKey;
    requestIdBytes: number[];
    serializedOutput: number[];
    signature: ChainSignaturesSignature;
    erc20AddressBytes: number[];
    requester: PublicKey;
  }): Promise<string> {
    const erc20Bytes = Buffer.from(erc20AddressBytes);
    const [userBalancePda] = deriveUserBalancePda(requester, erc20Bytes);
    const program = this.getBridgeProgram();

    // Derive transaction history PDA
    const [transactionHistory] = PublicKey.findProgramAddressSync(
      [Buffer.from('user_transaction_history'), requester.toBuffer()],
      program.programId,
    );

    return await program.methods
      .completeWithdrawErc20(
        Array.from(requestIdBytes),
        serializedOutput,
        signature,
      )
      .accounts({
        userBalance: userBalancePda,
        transactionHistory,
      } as never)
      .rpc();
  }

  /**
   * Fetch pending withdrawal details
   */
  async fetchPendingWithdrawal(
    pendingWithdrawalPda: PublicKey,
  ): Promise<unknown> {
    return await this.getBridgeProgram().account.pendingErc20Withdrawal.fetch(
      pendingWithdrawalPda,
    );
  }

  /**
   * Fetch all user withdrawals directly from the UserTransactionHistory PDA.
   * This is much more efficient than scanning transaction history.
   */
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

      // Derive the user transaction history PDA
      const [userTransactionHistoryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_transaction_history'), userPublicKey.toBuffer()],
        program.programId,
      );

      // Fetch the transaction history account
      const transactionHistory =
        await program.account.userTransactionHistory.fetchNullable(
          userTransactionHistoryPda,
        );

      if (!transactionHistory) {
        // No transaction history exists for this user yet
        return [];
      }

      // Map the withdrawals from the transaction history
      const withdrawals = transactionHistory.withdrawals.map(
        (withdrawal: any) => ({
          requestId: Buffer.from(withdrawal.requestId).toString('hex'),
          amount: withdrawal.amount.toString(),
          erc20Address:
            '0x' + Buffer.from(withdrawal.erc20Address).toString('hex'),
          recipient:
            '0x' + Buffer.from(withdrawal.recipientAddress).toString('hex'),
          status: withdrawal.status.pending
            ? ('pending' as const)
            : withdrawal.status.failed
              ? ('pending' as const) // Can retry failed withdrawals
              : ('completed' as const),
          timestamp: withdrawal.timestamp.toNumber(),
          signature: undefined,
          ethereumTxHash: withdrawal.ethereumTxHash
            ? '0x' + Buffer.from(withdrawal.ethereumTxHash).toString('hex')
            : undefined,
        }),
      );

      // Sort by timestamp (newest first)
      return withdrawals.sort((a: any, b: any) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error(
        'Error fetching user withdrawals from transaction history:',
        error,
      );
      return [];
    }
  }

  // ================================
  // Helper Methods
  // ================================

  /**
   * Internal utility to run async map operations with a concurrency cap.
   */
  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length) as R[];
    let nextIndex = 0;

    const workers = Array.from(
      { length: Math.max(1, concurrency) },
      async () => {
        while (true) {
          const current = nextIndex++;
          if (current >= items.length) break;
          results[current] = await mapper(items[current], current);
        }
      },
    );

    await Promise.all(workers);
    return results;
  }

  /**
   * Fetch recent signatures and their corresponding transactions for an address
   */
  private async fetchTxsForAddress(
    address: PublicKey,
    limit: number,
  ): Promise<{
    signatures: ConfirmedSignatureInfo[];
    transactions: (VersionedTransactionResponse | null)[];
  }> {
    const signatures = await cachedGetSignaturesForAddress(
      this.connection,
      address,
      {
        limit,
      },
    );
    const transactions = await this.mapWithConcurrency(
      signatures,
      this.TRANSACTION_FETCH_CONCURRENCY,
      sig =>
        cachedGetTransaction(this.connection, sig.signature, {
          maxSupportedTransactionVersion: 0,
        }),
    );
    return { signatures, transactions };
  }

  /**
   * Extract and decode this program's instructions from a transaction
   */
  private extractProgramInstructionsFromTx(
    tx: VersionedTransactionResponse,
    coder: Program['coder'],
  ): Array<{
    name: string;
    data: DecodedIx['data'];
    accountKeys: PublicKey[];
    accountKeyIndexes: number[];
  }> {
    const accountKeys = tx.transaction.message.staticAccountKeys;
    const instructions = tx.transaction.message.compiledInstructions;
    const decodedEvents: Array<{
      name: string;
      data: DecodedIx['data'];
      accountKeys: PublicKey[];
      accountKeyIndexes: number[];
    }> = [];

    for (const ix of instructions) {
      const programId = accountKeys[ix.programIdIndex];
      if (!programId.equals(BRIDGE_PROGRAM_ID)) continue;
      const decoded = this.safeDecodeInstruction(
        coder,
        ix.data,
      ) as DecodedIx | null;
      if (!decoded) continue;
      decodedEvents.push({
        name: decoded.name,
        data: decoded.data,
        accountKeys,
        accountKeyIndexes: ix.accountKeyIndexes as number[],
      });
    }
    return decodedEvents;
  }

  /**
   * Reasonable defaults to avoid RPC saturation while keeping UI responsive.
   */
  private readonly TRANSACTION_FETCH_CONCURRENCY = 4; // tighter to avoid RPC bursts
  private readonly SIGNATURE_SCAN_LIMIT = 10; // scan fewer per address

  /**
   * Convert hex string to bytes array
   */
  hexToBytes(hex: string): number[] {
    // Prefer viem's toBytes in call sites; keep minimal fallback here
    const cleanHex = hex.replace(/^0x/, '');
    return Array.from(Buffer.from(cleanHex, 'hex'));
  }

  // Removed trivial wrappers like erc20AddressToBytes; prefer viem's toBytes at call sites

  /**
   * Derive deposit address for a given user public key
   * This replaces the SolanaService.deriveDepositAddress method
   */
  deriveDepositAddress(publicKey: PublicKey): string {
    const [vaultAuthority] = deriveVaultAuthorityPda(publicKey);
    const path = publicKey.toString();
    return deriveEthereumAddress(
      path,
      vaultAuthority.toString(),
      CHAIN_SIGNATURES_CONFIG.BASE_PUBLIC_KEY,
    );
  }

  /**
   * Fetch recent claimErc20 events for a user and map them to ERC20 token addresses with timestamps
   */
  async fetchRecentUserClaims(
    userPublicKey: PublicKey,
    maxTransactions = 50,
  ): Promise<Record<string, number>> {
    try {
      const claimsByToken: Record<string, number> = {};

      const signatures = await cachedGetSignaturesForAddress(
        this.connection,
        userPublicKey,
        { limit: maxTransactions },
      );

      // Precompute mapping from userBalance PDA -> token address
      const pdaToTokenAddress = new Map<string, string>();
      for (const token of getAllErc20Tokens()) {
        const erc20Bytes = Buffer.from(token.address.replace('0x', ''), 'hex');
        const [pda] = deriveUserBalancePda(userPublicKey, erc20Bytes);
        pdaToTokenAddress.set(pda.toBase58(), token.address);
      }

      const program = this.getBridgeProgram();
      const coder = program.coder;

      const txs = await this.mapWithConcurrency(
        signatures,
        this.TRANSACTION_FETCH_CONCURRENCY,
        sig =>
          cachedGetTransaction(this.connection, sig.signature, {
            maxSupportedTransactionVersion: 0,
          }),
      );

      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i];
        const sig = signatures[i];
        if (!tx || !tx.meta || tx.meta.err) continue;

        const accountKeys = tx.transaction.message.staticAccountKeys;
        const instructions = tx.transaction.message.compiledInstructions;

        for (const ix of instructions) {
          const programId = accountKeys[ix.programIdIndex];
          if (!programId.equals(BRIDGE_PROGRAM_ID)) continue;

          const decoded = this.safeDecodeInstruction(coder, ix.data);
          if (!decoded) continue;
          if (decoded.name !== 'claimErc20') continue;

          const userBalanceAccountIndex = ix.accountKeyIndexes[2];
          const userBalanceAccount = accountKeys[userBalanceAccountIndex];
          const tokenAddress = pdaToTokenAddress.get(
            userBalanceAccount.toBase58(),
          );
          if (tokenAddress) {
            const ts = sig.blockTime || Math.floor(Date.now() / 1000);
            const existing = claimsByToken[tokenAddress];
            if (!existing || ts > existing) claimsByToken[tokenAddress] = ts;
          }
        }
      }

      return claimsByToken;
    } catch (error) {
      console.error('Error fetching recent user claims:', error);
      return {};
    }
  }

  /**
   * Fetch all user deposits directly from the UserTransactionHistory PDA.
   * This is much more efficient than scanning transaction history.
   */
  async fetchAllUserDeposits(userPublicKey: PublicKey): Promise<
    {
      requestId: string;
      amount: string;
      erc20Address: string;
      timestamp: number;
      status: 'pending' | 'completed';
    }[]
  > {
    try {
      const program = this.getBridgeProgram();

      // Derive the user transaction history PDA
      const [userTransactionHistoryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_transaction_history'), userPublicKey.toBuffer()],
        program.programId,
      );

      // Fetch the transaction history account
      const transactionHistory =
        await program.account.userTransactionHistory.fetchNullable(
          userTransactionHistoryPda,
        );

      if (!transactionHistory) {
        // No transaction history exists for this user yet
        return [];
      }

      // Map the deposits from the transaction history
      const deposits = transactionHistory.deposits.map((deposit: any) => ({
        requestId: Buffer.from(deposit.requestId).toString('hex'),
        amount: deposit.amount.toString(),
        erc20Address: '0x' + Buffer.from(deposit.erc20Address).toString('hex'),
        timestamp: deposit.timestamp.toNumber(),
        status: deposit.status.pending
          ? ('pending' as const)
          : deposit.status.failed
            ? ('pending' as const) // Treat failed as pending for deposits
            : ('completed' as const),
      }));

      // Sort by timestamp (newest first)
      return deposits.sort((a: any, b: any) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error(
        'Error fetching user deposits from transaction history:',
        error,
      );
      return [];
    }
  }

  // ================================
  // Internal decode and formatting helpers
  // ================================

  private safeDecodeInstruction(
    coder: Program['coder'],
    data: unknown,
  ): DecodedIx | null {
    const candidates: Buffer[] = [];
    if (typeof data === 'string') {
      if (/^[0-9a-fA-F]+$/.test(data) && data.length % 2 === 0) {
        try {
          candidates.push(Buffer.from(data, 'hex'));
        } catch {}
      }
      try {
        candidates.push(Buffer.from(data, 'base64'));
      } catch {}
      try {
        candidates.push(Buffer.from(data));
      } catch {}
    } else {
      try {
        candidates.push(Buffer.from(data as Uint8Array));
      } catch {}
    }

    const decoder = coder.instruction as unknown as {
      decode: (b: Buffer) => DecodedIx | null;
    };
    for (const buf of candidates) {
      try {
        const decoded = decoder.decode(buf);
        if (decoded) return decoded;
      } catch {}
    }
    return null;
  }

  private toHex(bytes: Uint8Array | number[]): string {
    return Buffer.from(bytes as Uint8Array).toString('hex');
  }
}

type DecodedIx = {
  name: string;
  data: {
    requestId: Uint8Array | number[];
    erc20Address?: Uint8Array | number[];
    amount?: { toString(): string } | number | string | bigint;
    requester?: string | Uint8Array | number[] | PublicKey;
    recipientAddress?: Uint8Array | number[];
  };
};

function hasToStringMethod(v: unknown): v is { toString(): string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    'toString' in v &&
    typeof (v as { toString: unknown }).toString === 'function'
  );
}

function toStringSafe(value: unknown): string {
  if (value == null) return '0';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (hasToStringMethod(value)) {
    try {
      return value.toString();
    } catch {
      return '0';
    }
  }
  return '0';
}

function toPublicKey(
  v: string | Uint8Array | number[] | PublicKey | undefined,
): PublicKey {
  if (!v) throw new Error('Missing public key');
  if (v instanceof PublicKey) return v;
  if (typeof v === 'string') return new PublicKey(v);
  return new PublicKey(Buffer.from(v));
}
