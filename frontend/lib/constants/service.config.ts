/**
 * Service configuration constants to centralize hardcoded values
 * across the application services.
 */

export const SERVICE_CONFIG = {
  ETHEREUM: {
    /** Sepolia testnet chain ID */
    CHAIN_ID: 11155111,
    /** Ethereum SLIP-44 coin type */
    SLIP44_COIN_TYPE: 60,
    /** CAIP-2 chain ID (eip155:chainId format) */
    CAIP2_ID: 'eip155:11155111',
  },
  CRYPTOGRAPHY: {
    /** Signature algorithm for chain signatures */
    SIGNATURE_ALGORITHM: 'ECDSA',
    /** Target blockchain for signatures */
    TARGET_BLOCKCHAIN: 'ethereum',
    /** Root path for withdrawal operations */
    WITHDRAWAL_ROOT_PATH: 'root',
    /** Path for deriving the MPC respond key (used for respondBidirectional signature verification) */
    SOLANA_RESPOND_BIDIRECTIONAL_PATH: 'solana response key',
  },
  TIMEOUTS: {
    /** Auto-cleanup interval for expired subscriptions (30 minutes) */
    CLEANUP_INTERVAL: 1800000,
    /** Maximum age for subscriptions before auto-cleanup (2 hours) */
    MAX_SUBSCRIPTION_AGE: 7200000,
  },
  BALANCE: {
    /** Range for random subtraction to work around contract constraints */
    RANDOM_SUBTRACTION_RANGE: 1000,
    /** Default token decimals when contract call fails */
    DEFAULT_TOKEN_DECIMALS: 18,
    /** Minimum balance threshold (in token units after decimals) */
    MINIMUM_BALANCE: 0.01,
  },
  RETRY: {
    /** Default number of retries for failed operations */
    DEFAULT_RETRIES: 2,
    /** Default key version for request generation */
    DEFAULT_KEY_VERSION: 1,
  },
} as const;
