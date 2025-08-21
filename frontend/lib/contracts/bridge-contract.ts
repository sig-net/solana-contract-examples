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
  derivePendingDepositPda,
  derivePendingWithdrawalPda,
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

    return await this.getBridgeProgram()
      .methods.depositErc20(
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
      } as never)
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

    return await this.getBridgeProgram()
      .methods.claimErc20(
        Array.from(requestIdBytes),
        serializedOutput,
        signature,
      )
      .accounts({
        userBalance: userBalancePda,
      } as never)
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
    return await this.getBridgeProgram()
      .methods.withdrawErc20(
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
      } as never)
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

    return await this.getBridgeProgram()
      .methods.completeWithdrawErc20(
        Array.from(requestIdBytes),
        serializedOutput,
        signature,
      )
      .accounts({
        userBalance: userBalancePda,
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
   * Fetch comprehensive user withdrawal data by combining multiple sources
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
      const withdrawals: {
        requestId: string;
        amount: string;
        erc20Address: string;
        recipient: string;
        status: 'pending' | 'completed';
        timestamp: number;
        signature?: string;
        ethereumTxHash?: string;
      }[] = [];

      // Get historical transactions by parsing user's transaction history
      const program = this.getBridgeProgram();
      const coder = program.coder;

      const { signatures: userSigs, transactions: txs } =
        await this.fetchTxsForAddress(userPublicKey, this.SIGNATURE_SCAN_LIMIT);

      for (let i = 0; i < txs.length; i++) {
        const sig = userSigs[i];
        const tx = txs[i];
        if (!tx || !tx.meta || tx.meta.err) continue;

        const decodedIxs = this.extractProgramInstructionsFromTx(tx, coder);
        for (const {
          name,
          data,
          accountKeys,
          accountKeyIndexes,
        } of decodedIxs) {
          if (name === 'withdrawErc20') {
            const requestId = Buffer.from(data.requestId).toString('hex');
            const erc20Address = '0x' + this.toHex(data.erc20Address ?? []);
            const amount = toStringSafe(data.amount);
            const recipient = '0x' + this.toHex(data.recipientAddress ?? []);

            const userAccountIndex = accountKeys.findIndex(key =>
              key.equals(userPublicKey),
            );
            const ixAccounts = accountKeyIndexes;
            if (
              userAccountIndex !== -1 &&
              ixAccounts.includes(userAccountIndex)
            ) {
              if (!withdrawals.some(w => w.requestId === requestId)) {
                withdrawals.push({
                  requestId,
                  amount,
                  erc20Address,
                  recipient,
                  status: 'pending',
                  timestamp: sig.blockTime || Date.now() / 1000,
                  signature: sig.signature,
                  ethereumTxHash: undefined,
                });
              }
            }
          } else if (name === 'completeWithdrawErc20') {
            const requestId = Buffer.from(data.requestId).toString('hex');
            const existingIndex = withdrawals.findIndex(
              w => w.requestId === requestId,
            );
            if (existingIndex !== -1) {
              withdrawals[existingIndex].status = 'completed';
            }
          }
        }
      }

      // Additionally, scan the user's userBalance PDAs per token used in withdrawals
      // to detect completion transactions that are not signed by the user (relayer-signed).
      const tokensToCheck = new Set<string>();
      for (const w of withdrawals) {
        tokensToCheck.add(w.erc20Address.toLowerCase());
      }

      for (const tokenAddress of tokensToCheck) {
        try {
          const erc20Bytes = Buffer.from(tokenAddress.replace('0x', ''), 'hex');
          const [userBalancePda] = deriveUserBalancePda(
            userPublicKey,
            erc20Bytes,
          );

          const ubSignatures = await cachedGetSignaturesForAddress(
            this.connection,
            userBalancePda,
            { limit: this.SIGNATURE_SCAN_LIMIT },
          );

          const ubTxs = await this.mapWithConcurrency(
            ubSignatures,
            this.TRANSACTION_FETCH_CONCURRENCY,
            sig =>
              cachedGetTransaction(this.connection, sig.signature, {
                maxSupportedTransactionVersion: 0,
              }),
          );

          for (let i = 0; i < ubTxs.length; i++) {
            const tx = ubTxs[i];
            try {
              if (!tx || !tx.meta || tx.meta.err) continue;
              const decodedIxs = this.extractProgramInstructionsFromTx(
                tx,
                coder,
              );
              for (const di of decodedIxs) {
                if (di.name === 'completeWithdrawErc20') {
                  const reqId = Buffer.from(di.data.requestId).toString('hex');
                  const idx = withdrawals.findIndex(w => w.requestId === reqId);
                  if (idx !== -1) {
                    withdrawals[idx].status = 'completed';
                  }
                }
              }
            } catch {
              continue;
            }
          }
        } catch {
          continue;
        }
      }

      // Final verification: check pending PDA existence to ensure accurate status
      try {
        const program = this.getBridgeProgram();
        await this.mapWithConcurrency(
          withdrawals,
          this.TRANSACTION_FETCH_CONCURRENCY,
          async (w, _i) => {
            try {
              const requestIdBytes = this.hexToBytes(w.requestId);
              const [pendingWithdrawalPda] =
                derivePendingWithdrawalPda(requestIdBytes);
              const account =
                await program.account.pendingErc20Withdrawal.fetchNullable(
                  pendingWithdrawalPda,
                );
              if (!account) {
                // If the pending account no longer exists, the withdrawal is completed
                w.status = 'completed';
              }
            } catch {
              // On any RPC decode error, leave prior inferred status
            }
          },
        );
      } catch {
        // If verification fails, fall back to previously inferred statuses
      }

      // Sort by timestamp (newest first)
      return withdrawals.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error('Error fetching all user withdrawals:', error);
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
   * Fetch all user deposits (pending + completed) by scanning Solana transactions.
   * A deposit becomes "initiated" when depositErc20 is called (pending_erc20_deposit created).
   * It becomes "completed" when claimErc20 is executed for the same requestId.
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
    const deposits: Map<
      string,
      {
        requestId: string;
        amount: string;
        erc20Address: string;
        timestamp: number;
        status: 'pending' | 'completed';
      }
    > = new Map();

    try {
      const program = this.getBridgeProgram();
      const coder = program.coder;

      // 1) Scan requester PDA transactions for depositErc20
      const [requesterPda] = deriveVaultAuthorityPda(userPublicKey);
      const fetched = await this.fetchTxsForAddress(
        requesterPda,
        this.SIGNATURE_SCAN_LIMIT,
      );
      const requesterSignatures = fetched.signatures;
      const requesterTxs = fetched.transactions;

      for (let i = 0; i < requesterTxs.length; i++) {
        const sig = requesterSignatures[i];
        const tx = requesterTxs[i];
        try {
          if (!tx || !tx.meta || tx.meta.err) continue;
          const decodedIxs = this.extractProgramInstructionsFromTx(tx, coder);
          for (const di of decodedIxs) {
            if (di.name !== 'depositErc20') continue;
            const data = di.data;
            const requesterHex = toPublicKey(data.requester).toString();
            if (requesterHex !== userPublicKey.toString()) continue;

            const requestId = Buffer.from(data.requestId).toString('hex');
            const erc20Address = '0x' + this.toHex(data.erc20Address ?? []);
            const amount = toStringSafe(data.amount);
            const timestamp = sig.blockTime || Math.floor(Date.now() / 1000);

            deposits.set(requestId, {
              requestId,
              amount,
              erc20Address,
              timestamp,
              status: 'pending',
            });
          }
        } catch {
          continue;
        }
      }

      // 2) Scan user balance PDAs per token for claimErc20 and flip status
      // Limit scan set to tokens we actually saw in deposits
      const tokensToCheck = new Set<string>();
      for (const d of deposits.values())
        tokensToCheck.add(d.erc20Address.toLowerCase());
      const erc20ScanList = getAllErc20Tokens().filter(t =>
        tokensToCheck.has(t.address.toLowerCase()),
      );
      for (const token of erc20ScanList) {
        try {
          const erc20Bytes = Buffer.from(
            token.address.replace('0x', ''),
            'hex',
          );
          const [userBalancePda] = deriveUserBalancePda(
            userPublicKey,
            erc20Bytes,
          );
          const signatures = await cachedGetSignaturesForAddress(
            this.connection,
            userBalancePda,
            { limit: this.SIGNATURE_SCAN_LIMIT },
          );

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
            try {
              if (!tx || !tx.meta || tx.meta.err) continue;
              const decodedIxs = this.extractProgramInstructionsFromTx(
                tx,
                coder,
              );
              for (const di of decodedIxs) {
                if (di.name !== 'claimErc20') continue;
                const data = di.data;
                const requestId = Buffer.from(data.requestId).toString('hex');
                const existing = deposits.get(requestId);
                if (existing) {
                  existing.status = 'completed';
                  deposits.set(requestId, existing);
                }
              }
            } catch {
              continue;
            }
          }
        } catch {
          continue;
        }
      }

      const list = Array.from(deposits.values());

      // Final verification: for each request, check if the pending deposit PDA still exists
      try {
        const program = this.getBridgeProgram();
        await this.mapWithConcurrency(
          list,
          this.TRANSACTION_FETCH_CONCURRENCY,
          async (d, _i) => {
            try {
              const requestIdBytes = this.hexToBytes(d.requestId);
              const [pendingDepositPda] =
                derivePendingDepositPda(requestIdBytes);
              const account =
                await program.account.pendingErc20Deposit.fetchNullable(
                  pendingDepositPda,
                );
              if (!account) {
                // If the pending account no longer exists, the deposit has been claimed
                d.status = 'completed';
              }
            } catch {
              // Ignore per-item errors; keep inferred status
            }
          },
        );
      } catch {
        // If verification fails, continue with inferred statuses
      }

      return list.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error('Error fetching all user deposits:', error);
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
