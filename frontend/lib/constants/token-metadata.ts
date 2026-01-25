import { erc20Abi, type Hex } from 'viem';

import { getEthereumProvider } from '@/lib/rpc';

export interface TokenMetadata {
  address: string;
  symbol: string;
  name: string;
  decimals?: number;
}

export interface NetworkData {
  chain: string;
  chainName: string;
  symbol: string;
  tokens: TokenMetadata[];
}

// ERC20 tokens on Sepolia - hardcoded display metadata
const ERC20_TOKENS: TokenMetadata[] = [
  {
    address: '0xbe72e441bf55620febc26715db68d3494213d8cb',
    symbol: 'USDC',
    name: 'USD Coin',
  },
  {
    address: '0xB4F1737Af37711e9A5890D9510c9bB60e170CB0D',
    symbol: 'DAI',
    name: 'Dai',
  },
  {
    address: '0x0625aFB445C3B6B7B929342a04A22599fd5dBB59',
    symbol: 'COW',
    name: 'Cow Protocol',
  },
];

// Solana tokens (decimals hardcoded since no standard on-chain query)
const SOLANA_TOKENS: (TokenMetadata & { decimals: number })[] = [
  {
    address: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
  },
  {
    address: 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
    symbol: 'EURC',
    name: 'Euro',
    decimals: 6,
  },
];

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

// ERC20 allowlist lookup
const ERC20_ALLOWLIST_SET = new Set(
  ERC20_TOKENS.map(t => t.address.toLowerCase()),
);

export function isErc20Allowed(address: string): boolean {
  return ERC20_ALLOWLIST_SET.has(address.toLowerCase());
}

export function getErc20Allowlist(): string[] {
  return ERC20_TOKENS.map(t => t.address);
}

export function getSolanaTokens(): (TokenMetadata & { decimals: number })[] {
  return SOLANA_TOKENS;
}

export function getAllNetworks(): NetworkData[] {
  return NETWORKS_WITH_TOKENS;
}

export interface Erc20TokenMetadata extends TokenMetadata {
  chain: string;
  chainName: string;
}

export function getAllErc20Tokens(): Erc20TokenMetadata[] {
  return ERC20_TOKENS.map(token => ({
    ...token,
    chain: 'ethereum',
    chainName: 'Ethereum',
  }));
}

const TOKEN_METADATA_MAP = new Map<string, Erc20TokenMetadata>(
  getAllErc20Tokens().map(token => [token.address.toLowerCase(), token]),
);

export function getTokenMetadata(
  address: string,
): Erc20TokenMetadata | undefined {
  return TOKEN_METADATA_MAP.get(address.toLowerCase());
}

// Cache for on-chain decimals
const erc20DecimalsCache = new Map<string, number>();

/**
 * Fetch ERC20 decimals from chain. Display metadata (name/symbol) comes from hardcoded allowlist.
 */
export async function fetchErc20Decimals(address: string): Promise<number> {
  const normalizedAddress = address.toLowerCase();

  if (!isErc20Allowed(normalizedAddress)) {
    throw new Error(`Token not supported: ${address}`);
  }

  const cached = erc20DecimalsCache.get(normalizedAddress);
  if (cached !== undefined) {
    return cached;
  }

  const client = getEthereumProvider();
  const decimals = await client.readContract({
    address: address as Hex,
    abi: erc20Abi,
    functionName: 'decimals',
  });

  erc20DecimalsCache.set(normalizedAddress, decimals);
  return decimals;
}
