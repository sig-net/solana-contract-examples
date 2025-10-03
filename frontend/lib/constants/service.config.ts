/**
 * Service configuration constants to centralize hardcoded values
 * across the application services.
 */

export const ETHEREUM_CONFIG = {
  /** Sepolia testnet chain ID */
  CHAIN_ID: 11155111,
  /** Ethereum SLIP-44 coin type */
  SLIP44_COIN_TYPE: 60,
  /** CAIP-2 chain ID (eip155:chainId format) */
  CAIP2_ID: 'eip155:11155111',
} as const;

export const CRYPTOGRAPHY_CONFIG = {
  /** Signature algorithm for chain signatures */
  SIGNATURE_ALGORITHM: 'ECDSA',
  /** Target blockchain for signatures */
  TARGET_BLOCKCHAIN: 'ethereum',
  /** Root path for withdrawal operations */
  WITHDRAWAL_ROOT_PATH: 'root',
} as const;

export const TIMEOUT_CONFIG = {
  /** Cache TTL for token decimals (5 minutes) */
  CACHE_TTL: 300000,
  /** Fallback cache TTL (1 minute) */
  FALLBACK_CACHE_TTL: 60000,
  /** Auto-cleanup interval for expired subscriptions (30 minutes) */
  CLEANUP_INTERVAL: 1800000,
  /** Maximum age for subscriptions before auto-cleanup (2 hours) */
  MAX_SUBSCRIPTION_AGE: 7200000,
} as const;

export const BALANCE_CONFIG = {
  /** Range for random subtraction to work around contract constraints */
  RANDOM_SUBTRACTION_RANGE: 1000,
  /** Default token decimals when contract call fails */
  DEFAULT_TOKEN_DECIMALS: 18,
  /** Minimum balance threshold (in token units after decimals) */
  MINIMUM_BALANCE: 0.01,
} as const;

export const RETRY_CONFIG = {
  /** Default number of retries for failed operations */
  DEFAULT_RETRIES: 2,
  /** Default key version for request generation */
  DEFAULT_KEY_VERSION: 0,
} as const;

/**
 * Combined service configuration for easy import
 */
export const SERVICE_CONFIG = {
  ETHEREUM: ETHEREUM_CONFIG,
  CRYPTOGRAPHY: CRYPTOGRAPHY_CONFIG,
  TIMEOUTS: TIMEOUT_CONFIG,
  BALANCE: BALANCE_CONFIG,
  RETRY: RETRY_CONFIG,
} as const;
