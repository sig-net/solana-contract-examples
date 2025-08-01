import { Buffer } from 'buffer';

import {
  Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';
import { Program, AnchorProvider, BN, Wallet } from '@coral-xyz/anchor';

import { IDL, type SolanaCoreContracts } from '@/lib/program/idl';
import {
  BRIDGE_PROGRAM_ID,
  BRIDGE_PDA_SEEDS,
} from '@/lib/constants/bridge.constants';
import { CHAIN_SIGNATURES_PROGRAM_ID } from '@/lib/constants/chain-signatures.constants';
import { SYSTEM_PROGRAM_ID } from '@/lib/constants/service.constants';

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
   * Get the core contracts program instance
   */
  private getBridgeProgram(): Program<SolanaCoreContracts> {
    if (!this.program) {
      const provider = new AnchorProvider(this.connection, this.wallet, {
        commitment: 'confirmed',
      });
      this.program = new Program(IDL, provider);
    }
    return this.program;
  }

  /**
   * Reset the program instance (useful when wallet changes)
   */
  resetProgram(): void {
    this.program = null;
  }

  // ================================
  // PDA Derivation Methods
  // ================================

  /**
   * Derive vault authority PDA for a given user
   */
  deriveVaultAuthorityPda(userPublicKey: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(BRIDGE_PDA_SEEDS.VAULT_AUTHORITY), userPublicKey.toBuffer()],
      BRIDGE_PROGRAM_ID,
    );
  }

  /**
   * Derive pending deposit PDA for a given request ID
   */
  derivePendingDepositPda(requestIdBytes: number[]): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(BRIDGE_PDA_SEEDS.PENDING_ERC20_DEPOSIT),
        Buffer.from(requestIdBytes),
      ],
      BRIDGE_PROGRAM_ID,
    );
  }

  /**
   * Derive pending withdrawal PDA for a given request ID
   */
  derivePendingWithdrawalPda(requestIdBytes: number[]): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(BRIDGE_PDA_SEEDS.PENDING_ERC20_WITHDRAWAL),
        Buffer.from(requestIdBytes),
      ],
      BRIDGE_PROGRAM_ID,
    );
  }

  /**
   * Derive global vault authority PDA
   */
  deriveGlobalVaultAuthorityPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(BRIDGE_PDA_SEEDS.GLOBAL_VAULT_AUTHORITY)],
      BRIDGE_PROGRAM_ID,
    );
  }

  /**
   * Derive user balance PDA for a given user and ERC20 token
   */
  deriveUserBalancePda(
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

  /**
   * Derive chain signatures state PDA
   */
  deriveChainSignaturesStatePda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(BRIDGE_PDA_SEEDS.PROGRAM_STATE)],
      CHAIN_SIGNATURES_PROGRAM_ID,
    );
  }

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
   * Check if pending deposit exists
   */
  async checkPendingDepositExists(
    pendingDepositPda: PublicKey,
  ): Promise<boolean> {
    const accountInfo = await this.connection.getAccountInfo(pendingDepositPda);
    return accountInfo !== null;
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
      const [userBalancePda] = this.deriveUserBalancePda(
        userPublicKey,
        erc20Bytes,
      );

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
    authority,
    requestIdBytes,
    erc20AddressBytes,
    amount,
    evmParams,
  }: {
    authority: PublicKey;
    requestIdBytes: number[];
    erc20AddressBytes: number[];
    amount: BN;
    evmParams: any;
  }): Promise<string> {
    const [vaultAuthority] = this.deriveVaultAuthorityPda(authority);
    const [pendingDepositPda] = this.derivePendingDepositPda(requestIdBytes);
    const [chainSignaturesStatePda] = this.deriveChainSignaturesStatePda();

    return await this.getBridgeProgram()
      .methods.depositErc20(
        requestIdBytes,
        erc20AddressBytes,
        amount,
        evmParams,
      )
      .accounts({
        authority,
        requester: vaultAuthority,
        pendingDeposit: pendingDepositPda,
        feePayer: authority,
        chainSignaturesState: chainSignaturesStatePda,
        chainSignaturesProgram: CHAIN_SIGNATURES_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      } as any)
      .rpc();
  }

  /**
   * Call claimErc20 method with all accounts prepared
   */
  async claimErc20({
    authority,
    requestIdBytes,
    serializedOutput,
    signature,
    erc20AddressBytes,
  }: {
    authority: PublicKey;
    requestIdBytes: number[];
    serializedOutput: number[];
    signature: any;
    erc20AddressBytes: number[];
  }): Promise<string> {
    const [pendingDepositPda] = this.derivePendingDepositPda(requestIdBytes);
    const erc20Bytes = Buffer.from(erc20AddressBytes);
    const [userBalancePda] = this.deriveUserBalancePda(authority, erc20Bytes);

    return await this.getBridgeProgram()
      .methods.claimErc20(
        Array.from(requestIdBytes),
        serializedOutput,
        signature,
      )
      .accounts({
        authority,
        pendingDeposit: pendingDepositPda,
        userBalance: userBalancePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      } as any)
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
    evmParams: any;
  }): Promise<string> {
    const [globalVaultAuthority] = this.deriveGlobalVaultAuthorityPda();
    const [pendingWithdrawalPda] =
      this.derivePendingWithdrawalPda(requestIdBytes);
    const erc20Bytes = Buffer.from(erc20AddressBytes);
    const [userBalancePda] = this.deriveUserBalancePda(authority, erc20Bytes);

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
        requester: globalVaultAuthority,
        pendingWithdrawal: pendingWithdrawalPda,
        userBalance: userBalancePda,
        chainSignaturesState: this.deriveChainSignaturesStatePda()[0],
        chainSignaturesProgram: CHAIN_SIGNATURES_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      } as any)
      .rpc();
  }

  /**
   * Complete ERC20 withdrawal
   */
  async completeWithdrawErc20({
    authority,
    requestIdBytes,
    serializedOutput,
    signature,
    erc20AddressBytes,
  }: {
    authority: PublicKey;
    requestIdBytes: number[];
    serializedOutput: number[];
    signature: any;
    erc20AddressBytes: number[];
  }): Promise<string> {
    const [globalVaultAuthority] = this.deriveGlobalVaultAuthorityPda();
    const [pendingWithdrawalPda] =
      this.derivePendingWithdrawalPda(requestIdBytes);
    const erc20Bytes = Buffer.from(erc20AddressBytes);
    const [userBalancePda] = this.deriveUserBalancePda(authority, erc20Bytes);

    return await this.getBridgeProgram()
      .methods.completeWithdrawErc20(
        Array.from(requestIdBytes),
        serializedOutput,
        signature,
      )
      .accounts({
        authority,
        requester: globalVaultAuthority,
        pendingWithdrawal: pendingWithdrawalPda,
        userBalance: userBalancePda,
        chainSignaturesState: this.deriveChainSignaturesStatePda()[0],
        chainSignaturesProgram: CHAIN_SIGNATURES_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
      } as any)
      .rpc();
  }

  /**
   * Fetch pending withdrawal details
   */
  async fetchPendingWithdrawal(pendingWithdrawalPda: PublicKey): Promise<any> {
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
      try {
        const signatures = await this.connection.getSignaturesForAddress(
          userPublicKey,
          { limit: 50 }, // Get last 50 transactions
        );

        const program = this.getBridgeProgram();
        const coder = program.coder;

        for (const sig of signatures) {
          try {
            const tx = await this.connection.getTransaction(sig.signature, {
              maxSupportedTransactionVersion: 0,
            });

            if (!tx || !tx.meta || tx.meta.err) continue;

            // Check if this transaction involves the core contracts program
            const accountKeys = tx.transaction.message.staticAccountKeys;

            // Find instructions for our program
            const instructions = tx.transaction.message.compiledInstructions;

            for (const ix of instructions) {
              const programId = accountKeys[ix.programIdIndex];

              if (programId.equals(BRIDGE_PROGRAM_ID)) {
                try {
                  // Get instruction data as Buffer
                  const instructionDataBuf = Buffer.from(ix.data, 'base64');

                  // Use Anchor's coder to decode the instruction
                  let decodedInstruction: {
                    name: string;
                    data: any;
                  } | null = null;

                  try {
                    decodedInstruction =
                      coder.instruction.decode(instructionDataBuf);
                  } catch (decodeError) {
                    // Skip instructions we can't decode
                    continue;
                  }

                  if (!decodedInstruction) continue;

                  const { name: instructionName, data: decodedData } =
                    decodedInstruction;

                  // Handle withdrawErc20 instruction
                  if (instructionName === 'withdrawErc20') {
                    // Extract withdrawal data using IDL-decoded structure
                    const requestId = Buffer.from(
                      decodedData.requestId,
                    ).toString('hex');
                    const erc20Address =
                      '0x' +
                      Buffer.from(decodedData.erc20Address).toString('hex');
                    const amount = decodedData.amount.toString();
                    const recipient =
                      '0x' +
                      Buffer.from(decodedData.recipientAddress).toString('hex');

                    // Check if this withdrawal is for the current user
                    const userAccountIndex = accountKeys.findIndex(key =>
                      key.equals(userPublicKey),
                    );

                    // Get instruction accounts
                    const ixAccounts = ix.accountKeyIndexes;

                    if (
                      userAccountIndex !== -1 &&
                      ixAccounts.includes(userAccountIndex)
                    ) {
                      const withdrawalRecord = {
                        requestId,
                        amount,
                        erc20Address,
                        recipient,
                        status: 'pending' as const,
                        timestamp: sig.blockTime || Date.now() / 1000,
                        signature: sig.signature,
                        ethereumTxHash: undefined,
                      };

                      // Only add if not already in withdrawals list
                      const exists = withdrawals.some(
                        w => w.requestId === requestId,
                      );
                      if (!exists) {
                        withdrawals.push(withdrawalRecord);
                      }
                    }
                  }
                  // Handle completeWithdrawErc20 instruction
                  else if (instructionName === 'completeWithdrawErc20') {
                    const requestId = Buffer.from(
                      decodedData.requestId,
                    ).toString('hex');

                    // Update existing withdrawal to completed status if found
                    const existingIndex = withdrawals.findIndex(
                      w => w.requestId === requestId,
                    );
                    if (existingIndex !== -1) {
                      withdrawals[existingIndex].status = 'completed';
                    }
                  }
                } catch (decodeError) {
                  // Skip instructions we can't decode
                  continue;
                }
              }
            }
          } catch (error) {
            // Skip failed transaction parsing
            console.error('Error parsing transaction:', error);
            continue;
          }
        }
      } catch (error) {
        console.error('Error fetching transaction history:', error);
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
   * Convert hex string to bytes array
   */
  hexToBytes(hex: string): number[] {
    const cleanHex = hex.replace('0x', '');
    return Array.from(Buffer.from(cleanHex, 'hex'));
  }

  /**
   * Convert ERC20 address to bytes
   */
  erc20AddressToBytes(erc20Address: string): number[] {
    return Array.from(Buffer.from(erc20Address.slice(2), 'hex'));
  }

  /**
   * Get program ID
   */
  get programId(): PublicKey {
    return BRIDGE_PROGRAM_ID;
  }
}
