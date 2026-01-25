import { erc20Abi, type Hex } from 'viem';

import { getEthereumProvider } from '@/lib/rpc';

// Token display info - decimals come from on-chain fetching
export interface TokenConfig {
  erc20Address: string;
  symbol: string;
  name: string;
  chain: 'ethereum' | 'solana';
}

// Type alias for UI components
export type TokenMetadata = TokenConfig;

// ERC20 tokens on Sepolia
const ERC20_TOKENS: TokenConfig[] = [
  {
    erc20Address: '0xbe72e441bf55620febc26715db68d3494213d8cb',
    symbol: 'USDC',
    name: 'USD Coin',
    chain: 'ethereum',
  },
  {
    erc20Address: '0xB4F1737Af37711e9A5890D9510c9bB60e170CB0D',
    symbol: 'DAI',
    name: 'Dai',
    chain: 'ethereum',
  },
  {
    erc20Address: '0x0625aFB445C3B6B7B929342a04A22599fd5dBB59',
    symbol: 'COW',
    name: 'Cow Protocol',
    chain: 'ethereum',
  },
];

// Solana tokens
const SOLANA_TOKENS: TokenConfig[] = [
  {
    erc20Address: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    symbol: 'USDC',
    name: 'USD Coin',
    chain: 'solana',
  },
  {
    erc20Address: 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
    symbol: 'EURC',
    name: 'Euro',
    chain: 'solana',
  },
];

export interface NetworkData {
  chain: 'ethereum' | 'solana';
  chainName: string;
  symbol: string;
  tokens: TokenConfig[];
}

export const NETWORKS_WITH_TOKENS: NetworkData[] = [
  {
    chain: 'ethereum',
    chainName: 'Ethereum',
    symbol: 'ethereum',
    tokens: ERC20_TOKENS,
  },
  {
    chain: 'solana',
    chainName: 'Solana',
    symbol: 'solana',
    tokens: SOLANA_TOKENS,
  },
];

// ERC20 functions
const ERC20_ALLOWLIST_SET = new Set(
  ERC20_TOKENS.map(t => t.erc20Address.toLowerCase()),
);

export function isErc20Allowed(address: string): boolean {
  return ERC20_ALLOWLIST_SET.has(address.toLowerCase());
}

export function getErc20Allowlist(): string[] {
  return ERC20_TOKENS.map(t => t.erc20Address);
}

export function getAllErc20Tokens(): TokenConfig[] {
  return ERC20_TOKENS;
}

const ERC20_TOKEN_MAP = new Map<string, TokenConfig>(
  ERC20_TOKENS.map(token => [token.erc20Address.toLowerCase(), token]),
);

export function getErc20Token(address: string): TokenConfig | undefined {
  return ERC20_TOKEN_MAP.get(address.toLowerCase());
}

// Solana functions
export function getSolanaTokens(): TokenConfig[] {
  return SOLANA_TOKENS;
}

const SOLANA_TOKEN_MAP = new Map<string, TokenConfig>(
  SOLANA_TOKENS.map(token => [token.erc20Address, token]),
);

export function getSolanaToken(address: string): TokenConfig | undefined {
  return SOLANA_TOKEN_MAP.get(address);
}

// Network functions
export function getAllNetworks(): NetworkData[] {
  return NETWORKS_WITH_TOKENS;
}

// Fetch ERC20 decimals from chain
export async function fetchErc20Decimals(address: string): Promise<number> {
  if (!isErc20Allowed(address)) {
    throw new Error(`Token not supported: ${address}`);
  }

  const client = getEthereumProvider();
  const decimals = await client.readContract({
    address: address as Hex,
    abi: erc20Abi,
    functionName: 'decimals',
  });

  return decimals;
}
