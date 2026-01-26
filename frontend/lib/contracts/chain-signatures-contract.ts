import { Connection, PublicKey } from '@solana/web3.js';
import {
  AnchorProvider,
  Wallet,
  utils as anchorUtils,
} from '@coral-xyz/anchor';
import { contracts } from 'signet.js';

import { getClientEnv } from '@/lib/config/env.config';
import type { EventListenerResult } from '../types/chain-signatures.types';
import {
  RESPONDER_ADDRESS,
  CHAIN_SIGNATURES_PROGRAM_ID,
} from '../constants/addresses';

const env = getClientEnv();

export class ChainSignaturesContract {
  private eventConnection: Connection;
  private wallet: Wallet;

  constructor(
    connection: Connection,
    wallet: Wallet,
    eventConnection?: Connection,
  ) {
    this.eventConnection = eventConnection || connection;
    this.wallet = wallet;
  }

  private getRootPublicKeyForSignet(): `secp256k1:${string}` {
    const rootPublicKey = env.NEXT_PUBLIC_MPC_ROOT_PUBLIC_KEY;
    const rootPublicKeyUncompressed = Array.from(
      Buffer.from(rootPublicKey.slice(2), 'hex'),
    );
    const publicKeyBytes = rootPublicKeyUncompressed.slice(1);
    const base58PublicKey = anchorUtils.bytes.bs58.encode(publicKeyBytes);
    return `secp256k1:${base58PublicKey}`;
  }

  async setupEventListeners(requestId: string): Promise<EventListenerResult> {
    const provider = new AnchorProvider(this.eventConnection, this.wallet, {
      commitment: 'confirmed',
    });

    const signetContract = new contracts.solana.ChainSignatureContract({
      provider,
      programId: CHAIN_SIGNATURES_PROGRAM_ID,
      config: {
        rootPublicKey: this.getRootPublicKeyForSignet(),
      },
    });

    const controller = new AbortController();

    const signature = signetContract.waitForEvent({
      eventName: 'signatureRespondedEvent',
      requestId,
      signer: new PublicKey(RESPONDER_ADDRESS),
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    const respondBidirectional = signetContract.waitForEvent({
      eventName: 'respondBidirectionalEvent',
      requestId,
      signer: new PublicKey(RESPONDER_ADDRESS),
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    return {
      signature,
      respondBidirectional,
      cleanup: () => controller.abort(),
    };
  }
}
