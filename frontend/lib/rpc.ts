import { Connection } from '@solana/web3.js';
import { Alchemy, Network } from 'alchemy-sdk';
import { createPublicClient, http, type PublicClient } from 'viem';
import { sepolia } from 'viem/chains';

import { getClientEnv } from '@/lib/config/env.config';

let cachedEthereumProvider: PublicClient | null = null;

export function getEthereumProvider(): PublicClient {
  if (cachedEthereumProvider) {
    return cachedEthereumProvider;
  }
  const rpcUrl = getAlchemyEthSepoliaRpcUrl();
  cachedEthereumProvider = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });
  return cachedEthereumProvider;
}

export function getHeliusConnection(): Connection | undefined {
  const env = getClientEnv();

  if (env.NEXT_PUBLIC_HELIUS_RPC_URL) {
    return new Connection(env.NEXT_PUBLIC_HELIUS_RPC_URL);
  }

  return undefined;
}

let cachedAlchemyProvider: Alchemy | null = null;

export function getAlchemyProvider(): Alchemy {
  if (cachedAlchemyProvider) {
    return cachedAlchemyProvider;
  }
  const env = getClientEnv();
  cachedAlchemyProvider = new Alchemy({
    apiKey: env.NEXT_PUBLIC_ALCHEMY_API_KEY,
    network: Network.ETH_SEPOLIA,
  });
  return cachedAlchemyProvider;
}

export function getAlchemyEthSepoliaRpcUrl(): string {
  const env = getClientEnv();
  return `https://eth-sepolia.g.alchemy.com/v2/${env.NEXT_PUBLIC_ALCHEMY_API_KEY}`;
}

export function getAlchemySolanaDevnetRpcUrl(): string {
  const env = getClientEnv();
  return `https://solana-devnet.g.alchemy.com/v2/${env.NEXT_PUBLIC_ALCHEMY_API_KEY}`;
}
