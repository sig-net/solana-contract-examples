import { ethers } from 'ethers';
import { Connection } from '@solana/web3.js';
import { Alchemy, Network } from 'alchemy-sdk';

import { getClientEnv } from './utils/env';

export type SupportedChain = 'ethereum-sepolia' | 'solana';

export function getEthereumProvider(): ethers.JsonRpcProvider {
  const rpcUrl = getAlchemyEthSepoliaRpcUrl();
  return new ethers.JsonRpcProvider(rpcUrl);
}

export function getHeliusConnection(): Connection | undefined {
  const env = getClientEnv();

  if (env.NEXT_PUBLIC_HELIUS_RPC_URL) {
    return new Connection(env.NEXT_PUBLIC_HELIUS_RPC_URL);
  }

  return undefined;
}

export function getAlchemyProvider(): Alchemy {
  const env = getClientEnv();
  const alchemy = new Alchemy({
    apiKey: env.NEXT_PUBLIC_ALCHEMY_API_KEY,
    network: Network.ETH_SEPOLIA,
  });

  return alchemy;
}

export function getAlchemyEthSepoliaRpcUrl(): string {
  const env = getClientEnv();
  return `https://eth-sepolia.g.alchemy.com/v2/${env.NEXT_PUBLIC_ALCHEMY_API_KEY}`;
}

export function getAlchemySolanaDevnetRpcUrl(): string {
  const env = getClientEnv();
  return `https://solana-devnet.g.alchemy.com/v2/${env.NEXT_PUBLIC_ALCHEMY_API_KEY}`;
}
