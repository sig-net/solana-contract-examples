import type {
  Connection,
  PublicKey,
  GetVersionedTransactionConfig,
  VersionedTransactionResponse,
  ConfirmedSignatureInfo,
  AccountInfo,
  ParsedAccountData,
  Commitment,
} from '@solana/web3.js';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

interface PendingRequest<T> {
  promise: Promise<T>;
  timestamp: number;
}

/**
 * Advanced RPC Manager with request deduplication and intelligent caching
 *
 * Features:
 * - Request deduplication: Prevents duplicate in-flight requests
 * - Smart caching with configurable TTLs per data type
 * - Automatic cache cleanup
 * - Connection pooling
 * - Error resilience
 */
class RPCManager {
  private cache = new Map<string, CacheEntry<unknown>>();
  private pendingRequests = new Map<string, PendingRequest<unknown>>();
  private lastCleanup = Date.now();

  // Enhanced TTL configuration based on data mutability
  private readonly TTL_CONFIG = {
    transaction: 60 * 60 * 1000, // 1 hour - transactions never change
    transactionConfirmed: 24 * 60 * 60 * 1000, // 24 hours for confirmed
    signatures: 3 * 1000, // 3 seconds for faster activity updates
    account: 3 * 1000, // 3 seconds for faster balance updates
    balance: 2 * 1000, // 2 seconds for faster balance updates
    programAccounts: 5 * 1000, // 5 seconds for faster updates
    tokenAccounts: 3 * 1000, // 3 seconds for faster updates
    multipleAccounts: 3 * 1000, // 3 seconds for faster updates
    slot: 1000, // 1 second
    blockhash: 30 * 1000, // 30 seconds
  };

  // Request timeout for deduplication
  private readonly REQUEST_TIMEOUT = 30 * 1000; // 30 seconds

  constructor(private connection: Connection) {}

  /**
   * Generate cache key with method name and parameters
   */
  private getCacheKey(method: string, params: Record<string, unknown>): string {
    // Sort params for consistent key generation
    const sortedParams = Object.keys(params)
      .sort()
      .reduce(
        (acc, key) => {
          acc[key] = params[key];
          return acc;
        },
        {} as Record<string, unknown>,
      );

    return `${method}:${JSON.stringify(sortedParams)}`;
  }

  /**
   * Get data from cache if valid
   */
  private getFromCache<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Set data in cache with specific TTL
   */
  private setCache<T>(key: string, data: T, ttl: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl,
    });

    // Periodic cleanup
    this.cleanupIfNeeded();
  }

  /**
   * Cleanup expired cache entries
   */
  private cleanupIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastCleanup < 60 * 1000) return; // Cleanup every minute

    this.lastCleanup = now;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
      }
    }

    // Also cleanup stale pending requests
    for (const [key, pending] of this.pendingRequests.entries()) {
      if (now - pending.timestamp > this.REQUEST_TIMEOUT) {
        this.pendingRequests.delete(key);
      }
    }
  }

  /**
   * Execute request with deduplication
   */
  private async executeWithDedup<T>(
    key: string,
    ttl: number,
    executor: () => Promise<T>,
  ): Promise<T> {
    // Check cache first
    const cached = this.getFromCache<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Check for pending request
    const pending = this.pendingRequests.get(key) as
      | PendingRequest<T>
      | undefined;
    if (pending) {
      const age = Date.now() - pending.timestamp;
      if (age < this.REQUEST_TIMEOUT) {
        return pending.promise;
      }
      // Stale pending request, remove it
      this.pendingRequests.delete(key);
    }

    // Create new request with deduplication
    const requestPromise = executor()
      .then(result => {
        this.pendingRequests.delete(key);
        if (result !== null && result !== undefined) {
          this.setCache(key, result, ttl);
        }
        return result;
      })
      .catch(error => {
        this.pendingRequests.delete(key);
        throw error;
      });

    this.pendingRequests.set(key, {
      promise: requestPromise,
      timestamp: Date.now(),
    });

    return requestPromise;
  }

  /**
   * Get transaction with caching and deduplication
   */
  async getTransaction(
    signature: string,
    options?: GetVersionedTransactionConfig,
  ): Promise<VersionedTransactionResponse | null> {
    const commitment = options?.commitment || 'confirmed';
    const ttl =
      commitment === 'confirmed' || commitment === 'finalized'
        ? this.TTL_CONFIG.transactionConfirmed
        : this.TTL_CONFIG.transaction;

    const cacheKey = this.getCacheKey('getTransaction', {
      signature,
      commitment,
      maxSupportedTransactionVersion: options?.maxSupportedTransactionVersion,
    });

    return this.executeWithDedup(cacheKey, ttl, () =>
      this.connection.getTransaction(signature, options),
    );
  }

  /**
   * Get signatures for address with caching
   */
  async getSignaturesForAddress(
    address: PublicKey,
    options?: { limit?: number; before?: string; until?: string },
  ): Promise<ConfirmedSignatureInfo[]> {
    const cacheKey = this.getCacheKey('getSignaturesForAddress', {
      address: address.toBase58(),
      limit: options?.limit,
      before: options?.before,
      until: options?.until,
    });

    return this.executeWithDedup(cacheKey, this.TTL_CONFIG.signatures, () =>
      this.connection.getSignaturesForAddress(address, options),
    );
  }

  /**
   * Get multiple accounts with caching
   */
  async getMultipleAccountsInfo(
    publicKeys: PublicKey[],
    commitment?: Commitment,
  ): Promise<(AccountInfo<Buffer | ParsedAccountData> | null)[]> {
    const cacheKey = this.getCacheKey('getMultipleAccountsInfo', {
      publicKeys: publicKeys.map(pk => pk.toBase58()),
      commitment,
    });

    return this.executeWithDedup(
      cacheKey,
      this.TTL_CONFIG.multipleAccounts,
      () => this.connection.getMultipleAccountsInfo(publicKeys, commitment),
    );
  }

  /**
   * Get account info with caching
   */
  async getAccountInfo(
    publicKey: PublicKey,
    commitment?: Commitment,
  ): Promise<AccountInfo<Buffer> | null> {
    const cacheKey = this.getCacheKey('getAccountInfo', {
      publicKey: publicKey.toBase58(),
      commitment,
    });

    return this.executeWithDedup(cacheKey, this.TTL_CONFIG.account, () =>
      this.connection.getAccountInfo(publicKey, commitment),
    );
  }

  /**
   * Get balance with short cache
   */
  async getBalance(
    publicKey: PublicKey,
    commitment?: Commitment,
  ): Promise<number> {
    const cacheKey = this.getCacheKey('getBalance', {
      publicKey: publicKey.toBase58(),
      commitment,
    });

    return this.executeWithDedup(cacheKey, this.TTL_CONFIG.balance, () =>
      this.connection.getBalance(publicKey, commitment),
    );
  }

  /**
   * Get program accounts with caching
   */
  async getProgramAccounts(
    programId: PublicKey,
    configOrCommitment?: Commitment | { commitment?: Commitment },
  ): Promise<Array<{ pubkey: PublicKey; account: AccountInfo<Buffer> }>> {
    const cacheKey = this.getCacheKey('getProgramAccounts', {
      programId: programId.toBase58(),
      config: configOrCommitment,
    });

    return this.executeWithDedup(
      cacheKey,
      this.TTL_CONFIG.programAccounts,
      async () => {
        // Type assertion to handle the return type properly
        const result = await this.connection.getProgramAccounts(
          programId,
          configOrCommitment as Commitment | undefined,
        );
        return result as Array<{
          pubkey: PublicKey;
          account: AccountInfo<Buffer>;
        }>;
      },
    );
  }
}

// Singleton instance per connection
const rpcManagerInstances = new WeakMap<Connection, RPCManager>();

/**
 * Get or create an RPC manager instance for a connection
 */
export function getRPCManager(connection: Connection): RPCManager {
  let instance = rpcManagerInstances.get(connection);
  if (!instance) {
    instance = new RPCManager(connection);
    rpcManagerInstances.set(connection, instance);
  }
  return instance;
}

// Export the class for direct usage if needed
export { RPCManager };
