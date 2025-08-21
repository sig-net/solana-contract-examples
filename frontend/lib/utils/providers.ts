import { ethers } from 'ethers';
import { Connection } from '@solana/web3.js';
import { Alchemy, Network } from 'alchemy-sdk';

import { getClientEnv, getSepoliaRpcUrl, getSolanaRpcUrl } from './env';

export type SupportedChain = 'ethereum-sepolia' | 'solana';

export function getEthereumProvider(): ethers.JsonRpcProvider {
  const rpcUrl = getSepoliaRpcUrl();
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  return provider;
}

export function getSolanaConnection(): Connection {
  const rpcUrl = getSolanaRpcUrl();
  const connection = new Connection(rpcUrl);

  return connection;
}

export function getHeliusConnection(): Connection | undefined {
  const env = getClientEnv();

  // Only return Helius connection if it's configured
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
