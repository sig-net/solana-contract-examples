import { Connection } from '@solana/web3.js';
import { Keypair } from '@solana/web3.js';
import NodeWallet from '@coral-xyz/anchor/dist/esm/nodewallet.js';
import { ethers } from 'ethers';

import {
  CrossChainOrchestrator,
  type CrossChainConfig,
} from '@/lib/services/cross-chain-orchestrator';
import { getFullEnv } from '@/lib/config/env.config';
import { getEthereumProvider, getHeliusConnection } from '@/lib/rpc';

export interface RelayerSetup {
  connection: Connection;
  provider: ethers.JsonRpcProvider;
  relayerWallet: NodeWallet;
  orchestrator: CrossChainOrchestrator;
}

export async function initializeRelayerSetup(
  config: CrossChainConfig = {},
): Promise<RelayerSetup> {
  const env = getFullEnv();

  // Use Helius for both command and event streams exclusively in relayers
  const eventConnection = getHeliusConnection();
  if (!eventConnection) {
    throw new Error('NEXT_PUBLIC_HELIUS_RPC_URL must be set for relayers');
  }
  const connection = eventConnection;

  const provider = getEthereumProvider();

  const relayerKeypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(env.RELAYER_PRIVATE_KEY)),
  );
  const relayerWallet = new NodeWallet(relayerKeypair);

  const orchestrator = new CrossChainOrchestrator(
    connection,
    relayerWallet,
    provider,
    config,
    eventConnection,
  );

  return {
    connection,
    provider,
    relayerWallet,
    orchestrator,
  };
}
