// Import token addresses from unified token metadata
import { ALL_TOKENS } from './token-metadata';

// Ethereum Network Configuration
export const ETHEREUM_CONFIG = {
  CHAIN_ID: 11155111, // Sepolia
  TRANSACTION_TYPE: 2, // EIP-1559
} as const;

// All ERC20 addresses as an array for compatibility
export const COMMON_ERC20_ADDRESSES = ALL_TOKENS.map(token => token.address);

// Hardcoded recipient address for transfers
export const HARDCODED_RECIPIENT_ADDRESS =
  '0x041477de8ecbcf633cb13ea10aa86cdf4d437c29';
