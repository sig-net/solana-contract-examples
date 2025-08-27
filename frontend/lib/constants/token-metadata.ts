export interface TokenMetadata {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface NetworkData {
  chain: string;
  chainName: string;
  symbol: string;
  tokens: TokenMetadata[];
}

export const NETWORKS_WITH_TOKENS: NetworkData[] = [
  {
    chain: 'ethereum',
    chainName: 'Ethereum',
    symbol: 'ethereum',
    tokens: [
      {
        address: '0xbe72e441bf55620febc26715db68d3494213d8cb',
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
      },
      {
        address: '0xB4F1737Af37711e9A5890D9510c9bB60e170CB0D',
        symbol: 'DAI',
        name: 'Dai',
        decimals: 18,
      },
      {
        address: '0x0625aFB445C3B6B7B929342a04A22599fd5dBB59',
        symbol: 'COW',
        name: 'Cow Protocol',
        decimals: 18,
      },
    ],
  },
  {
    chain: 'solana',
    chainName: 'Solana',
    symbol: 'solana',
    tokens: [
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
    ],
  },
];

export interface Erc20TokenMetadata extends TokenMetadata {
  chain: string;
  chainName: string;
}

export function getAllNetworks(): NetworkData[] {
  return NETWORKS_WITH_TOKENS;
}

export function getAllErc20Tokens(): Erc20TokenMetadata[] {
  return NETWORKS_WITH_TOKENS.filter(n => n.chain === 'ethereum').flatMap(
    network =>
      network.tokens.map(token => ({
        ...token,
        chain: network.chain,
        chainName: network.chainName,
      })),
  );
}

export const TOKEN_METADATA_MAP = new Map<string, Erc20TokenMetadata>(
  getAllErc20Tokens().map(token => [token.address.toLowerCase(), token]),
);

export function getTokenMetadata(
  address: string,
): Erc20TokenMetadata | undefined {
  return TOKEN_METADATA_MAP.get(address.toLowerCase());
}
