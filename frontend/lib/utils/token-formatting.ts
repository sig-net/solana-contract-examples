import type { TokenFormatInfo } from '@/lib/types/token.types';

import { getAlchemyProvider } from './providers';

const SYMBOL_NORMALIZATION_MAP: Record<string, string> = {
  USDC: 'USDC',
  'USDC.e': 'USDC',
  'USD Coin': 'USDC',
  USDCoin: 'USDC',

  ETH: 'ETH',
  WETH: 'ETH',
  'Wrapped Ether': 'ETH',

  SOL: 'SOL',
  WSOL: 'SOL',
  'Wrapped SOL': 'SOL',

  BTC: 'BTC',
  WBTC: 'BTC',
  'Wrapped Bitcoin': 'BTC',
};

function normalizeSymbolForDisplay(symbol: string, name: string): string {
  if (SYMBOL_NORMALIZATION_MAP[symbol]) {
    return SYMBOL_NORMALIZATION_MAP[symbol];
  }

  if (SYMBOL_NORMALIZATION_MAP[name]) {
    return SYMBOL_NORMALIZATION_MAP[name];
  }

  const symbolUpper = symbol.toUpperCase();
  if (symbolUpper.includes('USDC')) return 'USDC';
  if (symbolUpper.includes('ETH')) return 'ETH';
  if (symbolUpper.includes('SOL')) return 'SOL';
  if (symbolUpper.includes('BTC')) return 'BTC';

  return symbol;
}

const tokenInfoCache = new Map<string, { data: TokenFormatInfo; at: number }>();

const CACHE_DURATION = 24 * 60 * 60 * 1000;

const DEFAULT_TOKEN_INFO: TokenFormatInfo = {
  symbol: 'ERC20',
  decimals: 18,
  name: 'Unknown Token',
  displaySymbol: 'ERC20',
};

async function fetchTokenInfo(tokenAddress: string): Promise<TokenFormatInfo> {
  try {
    const alchemy = getAlchemyProvider();
    const meta = await alchemy.core.getTokenMetadata(tokenAddress);
    const symbolStr = meta?.symbol ?? DEFAULT_TOKEN_INFO.symbol;
    const nameStr = meta?.name ?? DEFAULT_TOKEN_INFO.name;
    const decimalsNum = typeof meta?.decimals === 'number' ? meta.decimals : 18;
    return {
      symbol: symbolStr,
      name: nameStr,
      decimals: decimalsNum,
      displaySymbol: normalizeSymbolForDisplay(symbolStr, nameStr),
    };
  } catch (error) {
    console.warn(`Failed to fetch token info for ${tokenAddress}:`, error);
    return DEFAULT_TOKEN_INFO;
  }
}

export async function getTokenInfo(
  tokenAddress: string,
): Promise<TokenFormatInfo> {
  const normalizedAddress = tokenAddress.toLowerCase();
  const cached = tokenInfoCache.get(normalizedAddress);
  if (cached && Date.now() - cached.at < CACHE_DURATION) return cached.data;

  const info = await fetchTokenInfo(tokenAddress);
  tokenInfoCache.set(normalizedAddress, { data: info, at: Date.now() });
  return info;
}

export function getTokenInfoSync(tokenAddress: string): TokenFormatInfo {
  const normalizedAddress = tokenAddress.toLowerCase();
  const cached = tokenInfoCache.get(normalizedAddress);
  return cached && Date.now() - cached.at < CACHE_DURATION
    ? cached.data
    : DEFAULT_TOKEN_INFO;
}

export async function preloadTokenInfo(
  tokenAddresses: string[],
): Promise<void> {
  const promises = tokenAddresses.map(address => getTokenInfo(address));
  await Promise.allSettled(promises);
}
