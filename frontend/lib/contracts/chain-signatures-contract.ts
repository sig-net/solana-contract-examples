import { Connection, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet, utils as anchorUtils } from '@coral-xyz/anchor';
import { contracts } from 'signet.js';
import type { Hex } from 'viem';

import { CHAIN_SIGNATURES_PROGRAM_IDL } from '@/lib/program/idl-chain-sig';
import { getClientEnv } from '@/lib/config/env.config';

import type {
  ChainSignaturesProgram,
  ChainSignaturesSignature,
  SignatureRespondedEvent,
  RespondBidirectionalEvent,
  EventPromises,
} from '../types/chain-signatures.types';
import { RESPONDER_ADDRESS, CHAIN_SIGNATURES_PROGRAM_ID } from '../constants/addresses';

const env = getClientEnv();

export class ChainSignaturesContract {
  private connection: Connection;
  private eventConnection: Connection;
  private wallet: Wallet;

  constructor(
    connection: Connection,
    wallet: Wallet,
    eventConnection?: Connection,
  ) {
    this.connection = connection;
    this.eventConnection = eventConnection || connection;
    this.wallet = wallet;
  }

  getProgram(): ChainSignaturesProgram {
    const provider = new AnchorProvider(this.connection, this.wallet, {
      commitment: 'confirmed',
    });

    return new Program(
      CHAIN_SIGNATURES_PROGRAM_IDL,
      provider,
    ) as ChainSignaturesProgram;
  }

  getEventProgram(): ChainSignaturesProgram {
    const provider = new AnchorProvider(this.eventConnection, this.wallet, {
      commitment: 'confirmed',
    });

    return new Program(
      CHAIN_SIGNATURES_PROGRAM_IDL,
      provider,
    ) as ChainSignaturesProgram;
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

  setupEventListeners(requestId: string): EventPromises {
    console.log('[EVENT] Setting up event listeners for requestId:', requestId);
    console.log('[EVENT] Expected responder:', RESPONDER_ADDRESS);

    let signatureResolve: (value: SignatureRespondedEvent) => void;
    let respondBidirectionalResolve: (value: RespondBidirectionalEvent) => void;
    let resolvedSignature = false;
    let resolvedRead = false;
    let backfillSignatureTimer: ReturnType<typeof setTimeout> | null = null;
    let backfillReadTimer: ReturnType<typeof setTimeout> | null = null;
    let signetUnsubscribe: (() => Promise<void>) | null = null;

    const signaturePromise = new Promise<SignatureRespondedEvent>(resolve => {
      signatureResolve = resolve;
    });

    const respondBidirectionalPromise = new Promise<RespondBidirectionalEvent>(resolve => {
      respondBidirectionalResolve = resolve;
    });

    const chainSignaturesProgram = this.getEventProgram();
    const eventProvider = new AnchorProvider(this.eventConnection, this.wallet, {
      commitment: 'confirmed',
    });

    const signetContract = new contracts.solana.ChainSignatureContract({
      provider: eventProvider,
      programId: CHAIN_SIGNATURES_PROGRAM_ID,
      config: {
        rootPublicKey: this.getRootPublicKeyForSignet(),
      },
    });

    signetContract.subscribeToEvents({
      onSignatureResponded: (event, slot) => {
        const eventRequestId = '0x' + Buffer.from(event.requestId).toString('hex');
        const eventResponder = event.responder.toBase58();

        console.log('[EVENT] signatureRespondedEvent received via signet.js:', {
          eventRequestId,
          expectedRequestId: requestId,
          eventResponder,
          expectedResponder: RESPONDER_ADDRESS,
          slot,
          requestIdMatch: eventRequestId === requestId,
          responderMatch: eventResponder === RESPONDER_ADDRESS,
        });

        if (eventRequestId === requestId && eventResponder === RESPONDER_ADDRESS) {
          if (!resolvedSignature) {
            resolvedSignature = true;
            console.log('[EVENT] Signature event matched! Resolving promise...');
            signatureResolve(event as SignatureRespondedEvent);
            if (resolvedSignature && resolvedRead) {
              if (backfillSignatureTimer) {
                clearTimeout(backfillSignatureTimer);
                backfillSignatureTimer = null;
              }
              if (backfillReadTimer) {
                clearTimeout(backfillReadTimer);
                backfillReadTimer = null;
              }
            }
          }
        } else {
          console.warn('[EVENT] Signature event mismatch - ignoring');
        }
      },
      onSignatureError: (event, slot) => {
        const eventRequestId = '0x' + Buffer.from(event.requestId).toString('hex');
        console.error('[EVENT] signatureErrorEvent received:', {
          eventRequestId,
          expectedRequestId: requestId,
          slot,
          error: event.error,
        });
      },
    }).then(unsubscribe => {
      signetUnsubscribe = unsubscribe;
      console.log('[EVENT] signet.js subscription established');
    }).catch(err => {
      console.error('[EVENT] Failed to subscribe via signet.js:', err);
    });

    const respondBidirectionalListener = chainSignaturesProgram.addEventListener(
      'respondBidirectionalEvent',
      (event: RespondBidirectionalEvent) => {
        const eventRequestId =
          '0x' + Buffer.from(event.requestId).toString('hex');
        const eventResponder = event.responder.toBase58();

        console.log('[EVENT] respondBidirectionalEvent received:', {
          eventRequestId,
          expectedRequestId: requestId,
          eventResponder,
          expectedResponder: RESPONDER_ADDRESS,
          requestIdMatch: eventRequestId === requestId,
          responderMatch: eventResponder === RESPONDER_ADDRESS,
        });

        if (eventRequestId === requestId && eventResponder === RESPONDER_ADDRESS) {
          if (!resolvedRead) {
            resolvedRead = true;
            console.log('[EVENT] RespondBidirectional event matched! Resolving promise...');
            respondBidirectionalResolve(event);
            if (resolvedSignature && resolvedRead) {
              if (backfillSignatureTimer) {
                clearTimeout(backfillSignatureTimer);
                backfillSignatureTimer = null;
              }
              if (backfillReadTimer) {
                clearTimeout(backfillReadTimer);
                backfillReadTimer = null;
              }
            }
          }
        } else {
          console.warn('[EVENT] RespondBidirectional event mismatch - ignoring');
        }
      },
    );

    console.log('[EVENT] Listeners registered:', {
      signetSubscription: 'pending',
      respondBidirectionalListenerId: respondBidirectionalListener,
    });

    const cleanup = () => {
      if (signetUnsubscribe) {
        signetUnsubscribe().catch(err => {
          console.error('[EVENT] Error unsubscribing from signet.js:', err);
        });
      }
      chainSignaturesProgram.removeEventListener(respondBidirectionalListener);
      if (backfillSignatureTimer) {
        clearTimeout(backfillSignatureTimer);
        backfillSignatureTimer = null;
      }
      if (backfillReadTimer) {
        clearTimeout(backfillReadTimer);
        backfillReadTimer = null;
      }
    };

    const backfillSignature = async () => {
      if (resolvedSignature) return;
      await this.tryBackfillEvents(
        requestId,
        sig => {
          if (!resolvedSignature) {
            resolvedSignature = true;
            signatureResolve(sig);
          }
        },
        () => {},
      );
    };

    const backfillRead = async () => {
      if (resolvedRead) return;
      await this.tryBackfillEvents(
        requestId,
        () => {},
        read => {
          if (!resolvedRead) {
            resolvedRead = true;
            respondBidirectionalResolve(read);
          }
        },
      );
    };

    return {
      signature: signaturePromise,
      respondBidirectional: respondBidirectionalPromise,
      cleanup,
      backfillSignature,
      backfillRead,
    };
  }

  static extractSignature(signature: ChainSignaturesSignature) {
    const r = ('0x' + Buffer.from(signature.bigR.x).toString('hex')) as Hex;
    const s = ('0x' + Buffer.from(signature.s).toString('hex')) as Hex;
    const v = BigInt(signature.recoveryId + 27);

    return { r, s, v };
  }

  private async tryBackfillEvents(
    requestId: string,
    onSignature: (event: SignatureRespondedEvent) => void,
    onrespondBidirectional: (event: RespondBidirectionalEvent) => void,
    maxSignatures = 5,
  ): Promise<void> {
    console.log('[BACKFILL] Starting backfill for requestId:', requestId);
    try {
      const program = this.getEventProgram();

      const responderPubkey = new PublicKey(RESPONDER_ADDRESS);
      console.log('[BACKFILL] Fetching signatures for responder:', responderPubkey.toBase58());
      const signatures = await this.eventConnection.getSignaturesForAddress(
        responderPubkey,
        { limit: maxSignatures },
      );
      console.log('[BACKFILL] Found', signatures.length, 'signatures');

      const CONCURRENCY = 4;
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, signatures.length) }).map(
          async () => {
            while (true) {
              const i = next++;
              const sig = signatures[i];
              if (!sig) break;
              try {
                console.log('[BACKFILL] Checking tx:', sig.signature);
                const tx = await this.eventConnection.getTransaction(
                  sig.signature,
                  {
                    maxSupportedTransactionVersion: 0,
                  },
                );
                const logs = tx?.meta?.logMessages ?? [];
                console.log('[BACKFILL] Tx has', logs.length, 'logs');
                for (const log of logs) {
                  try {
                    const decoded = program.coder.events.decode(log) as {
                      name: string;
                      data: SignatureRespondedEvent | RespondBidirectionalEvent;
                    } | null;
                    if (!decoded) continue;
                    const name = decoded.name as string;
                    console.log('[BACKFILL] Decoded event:', name);
                    if (
                      name === 'signatureRespondedEvent' ||
                      name === 'SignatureRespondedEvent' ||
                      name === 'respondBidirectionalEvent' ||
                      name === 'RespondBidirectionalEvent'
                    ) {
                      const eventReq =
                        '0x' +
                        Buffer.from(decoded.data.requestId).toString('hex');
                      console.log('[BACKFILL] Event requestId:', eventReq, 'expected:', requestId);
                      if (eventReq !== requestId) continue;
                      if (name === 'signatureRespondedEvent' || name === 'SignatureRespondedEvent') {
                        console.log('[BACKFILL] Found matching signature event!');
                        onSignature(decoded.data as SignatureRespondedEvent);
                      } else if (name === 'respondBidirectionalEvent' || name === 'RespondBidirectionalEvent') {
                        console.log('[BACKFILL] Found matching respondBidirectional event!');
                        onrespondBidirectional(decoded.data as RespondBidirectionalEvent);
                      }
                    }
                  } catch {
                    // ignore decode errors per-log
                  }
                }
              } catch (txErr) {
                console.error('[BACKFILL] Tx fetch error:', txErr);
              }
            }
          },
        ),
      );
      console.log('[BACKFILL] Backfill complete');
    } catch (err) {
      console.error('[BACKFILL] Overall error:', err);
    }
  }
}
