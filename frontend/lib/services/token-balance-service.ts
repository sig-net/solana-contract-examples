import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

import type { TokenBalance } from '@/lib/types/token.types';
import {
  getTokenMetadata,
  getAllErc20Tokens,
  NETWORKS_WITH_TOKENS,
} from '@/lib/constants/token-metadata';
import type { DexContract } from '@/lib/contracts/dex-contract';
import { getRPCManager } from '@/lib/utils/rpc-manager';
import { getAlchemyProvider } from '@/lib/rpc';

const decimalsCache = new Map<string, number>();

/**
 * TokenBalanceService handles all token balance operations including
 * fetching and processing ERC20 token balances.
 *
 * OPTIMIZED VERSION: Uses efficient RPC calls with filtering
 */
export class TokenBalanceService {
  private alchemy = getAlchemyProvider();
  private rpcManager: ReturnType<typeof getRPCManager>;

  constructor(private dexContract: DexContract) {
    this.rpcManager = getRPCManager(dexContract.getConnection());
  }

  private async resolveDecimals(erc20Address: string): Promise<number> {
    const normalized = erc20Address.toLowerCase();
    const cached = decimalsCache.get(normalized);
    if (cached !== undefined) return cached;

    const localMeta = getTokenMetadata(erc20Address);
    if (localMeta) {
      decimalsCache.set(normalized, localMeta.decimals);
      return localMeta.decimals;
    }

    try {
      const meta = await this.alchemy.core.getTokenMetadata(erc20Address);
      const decimals = meta?.decimals ?? 18;
      decimalsCache.set(normalized, decimals);
      return decimals;
    } catch {
      decimalsCache.set(normalized, 18);
      return 18;
    }
  }

  /**
   * Batch fetch ERC20 balances for multiple tokens
   */
  async batchFetchErc20Balances(
    address: string,
    tokenAddresses: string[],
  ): Promise<Array<{ address: string; balance: bigint; decimals: number }>> {
    try {
      // Use Alchemy's getTokenBalances for efficient batch fetching
      const balances = await this.alchemy.core.getTokenBalances(
        address,
        tokenAddresses,
      );

      if (!balances) {
        return this.fallbackBatchFetch(address, tokenAddresses);
      }

      const results: Array<{
        address: string;
        balance: bigint;
        decimals: number;
      }> = [];

      for (const tokenBalance of balances.tokenBalances) {
        const balance = BigInt(tokenBalance.tokenBalance || '0');

        const decimals = await this.resolveDecimals(tokenBalance.contractAddress);
        results.push({
          address: tokenBalance.contractAddress,
          balance,
          decimals,
        });
      }

      return results;
    } catch (error) {
      console.error('Error batch fetching token balances:', error);
      // Fallback to individual calls
      return this.fallbackBatchFetch(address, tokenAddresses);
    }
  }

  /**
   * Fallback method for individual balance fetching when batch fails
   */
  private async fallbackBatchFetch(
    address: string,
    tokenAddresses: string[],
  ): Promise<Array<{ address: string; balance: bigint; decimals: number }>> {
    const balancePromises = tokenAddresses.map(async tokenAddress => {
      try {
        const tokenBalances = await this.alchemy.core.getTokenBalances(
          address,
          [tokenAddress],
        );
        const balance = tokenBalances?.tokenBalances?.[0]?.tokenBalance || '0';
        const balanceBigInt = BigInt(balance || '0');

        const decimals = await this.resolveDecimals(tokenAddress);
        return { address: tokenAddress, balance: balanceBigInt, decimals };
      } catch (error) {
        console.error(`Error fetching balance for ${tokenAddress}:`, error);
        return { address: tokenAddress, balance: BigInt(0), decimals: 18 };
      }
    });

    return Promise.all(balancePromises);
  }

  /**
   * Fetch unclaimed balances from derived Ethereum address
   */
  async fetchUnclaimedBalances(
    derivedAddress: string,
  ): Promise<TokenBalance[]> {
    try {
      const tokenAddresses = getAllErc20Tokens().map(token => token.address);

      // Use batch fetching to reduce RPC calls
      const batchResults = await this.batchFetchErc20Balances(
        derivedAddress,
        tokenAddresses,
      );

      const results: TokenBalance[] = [];

      for (const result of batchResults) {
        if (result.balance > BigInt(0)) {
          const tokenMetadata = getTokenMetadata(result.address);
          results.push({
            erc20Address: result.address,
            amount: result.balance.toString(),
            symbol: tokenMetadata?.symbol || 'Unknown',
            name: tokenMetadata?.name || 'Unknown Token',
            decimals: result.decimals,
            chain: tokenMetadata?.chain || 'ethereum',
          });
        }
      }

      return results;
    } catch (error) {
      console.error('Error fetching unclaimed balances:', error);
      return [];
    }
  }

  /**
   * OPTIMIZED: Fetch user balances from Solana contract using efficient RPC calls
   */
  async fetchUserBalances(publicKey: PublicKey): Promise<TokenBalance[]> {
    try {
      const tokenAddresses = getAllErc20Tokens().map(token => token.address);

      // Fetch ERC20 balances from the bridge contract
      const balancesPromises = tokenAddresses.map(async erc20Address => {
        const balance = await this.dexContract.fetchUserBalance(
          publicKey,
          erc20Address,
        );
        if (balance !== '0') {
          const tokenMetadata = getTokenMetadata(erc20Address);
          return {
            erc20Address,
            amount: balance,
            decimals: 18, // Solana contract stores all ERC20 balances with 18 decimals
            symbol: tokenMetadata?.symbol ?? 'Unknown',
            name: tokenMetadata?.name ?? 'Unknown Token',
            chain: tokenMetadata?.chain ?? 'ethereum',
          };
        }
        return null;
      });

      const erc20Results = (await Promise.all(balancesPromises)).filter(
        (result): result is TokenBalance => result !== null,
      );

      // OPTIMIZED: Fetch SPL balances using getMultipleAccountsInfo instead of getParsedTokenAccountsByOwner
      const solanaNetwork = NETWORKS_WITH_TOKENS.find(
        n => n.chain === 'solana',
      );

      const splResults: TokenBalance[] = [];
      if (solanaNetwork && solanaNetwork.tokens.length > 0) {
        try {
          // Pre-compute all ATAs for known SPL tokens
          const ataAddresses: PublicKey[] = [];
          const tokenInfoMap = new Map<
            string,
            (typeof solanaNetwork.tokens)[0]
          >();

          for (const token of solanaNetwork.tokens) {
            try {
              const mintPubkey = new PublicKey(token.address);
              const ata = getAssociatedTokenAddressSync(
                mintPubkey,
                publicKey,
                true, // Allow owner off curve
              );
              ataAddresses.push(ata);
              tokenInfoMap.set(ata.toBase58(), token);
            } catch (e) {
              console.warn(`Failed to derive ATA for ${token.address}:`, e);
            }
          }

          // Batch fetch all ATAs in a single request using the RPC manager
          const accounts =
            await this.rpcManager.getMultipleAccountsInfo(ataAddresses);

          for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i];
            const ata = ataAddresses[i];
            if (!ata) continue;
            const ataAddress = ata.toBase58();
            const tokenInfo = tokenInfoMap.get(ataAddress);
            if (!tokenInfo) continue;

            let amount = '0';

            if (account && account.data && 'parsed' in account.data) {
              // Account exists and is parsed
              const parsed = account.data.parsed;
              if (parsed?.info?.tokenAmount?.amount) {
                amount = parsed.info.tokenAmount.amount;
              }
            } else if (
              account &&
              account.data &&
              Buffer.isBuffer(account.data)
            ) {
              // Account exists but needs manual parsing
              // Token account layout: first 64 bytes are mint and owner, next 8 bytes are amount
              if (account.data.length >= 72) {
                const amountBuffer = account.data.subarray(64, 72);
                const amountBigInt = amountBuffer.readBigUInt64LE();
                amount = amountBigInt.toString();
              }
            }

            splResults.push({
              erc20Address: tokenInfo.address,
              amount,
              decimals: tokenInfo.decimals,
              symbol: tokenInfo.symbol,
              name: tokenInfo.name,
              chain: 'solana',
            });
          }
        } catch (error) {
          console.error('Error fetching SPL balances:', error);
          // If batch fetch fails, include zeros for all tokens
          for (const token of solanaNetwork.tokens) {
            splResults.push({
              erc20Address: token.address,
              amount: '0',
              decimals: token.decimals,
              symbol: token.symbol,
              name: token.name,
              chain: 'solana',
            });
          }
        }
      }

      return [...erc20Results, ...splResults];
    } catch (error) {
      console.error('Failed to fetch user balances:', error);
      throw new Error(
        `Failed to fetch user balances: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

}
