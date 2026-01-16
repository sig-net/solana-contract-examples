import { Connection, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import type { Hex } from 'viem';

import { CHAIN_SIGNATURES_PROGRAM_IDL } from '@/lib/program/idl-chain-sig';

import type {
  ChainSignaturesProgram,
  ChainSignaturesSignature,
  SignatureRespondedEvent,
  RespondBidirectionalEvent,
  EventPromises,
} from '../types/chain-signatures.types';
import { RESPONDER_ADDRESS } from '../constants/addresses';

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

  setupEventListeners(requestId: string): EventPromises {
    let signatureResolve: (value: SignatureRespondedEvent) => void;
    let respondBidirectionalResolve: (value: RespondBidirectionalEvent) => void;
    let resolvedSignature = false;
    let resolvedRead = false;
    // Timers are managed by the waiter per-event; initialize as null
    let backfillSignatureTimer: ReturnType<typeof setTimeout> | null = null;
    let backfillReadTimer: ReturnType<typeof setTimeout> | null = null;

    const signaturePromise = new Promise<SignatureRespondedEvent>(resolve => {
      signatureResolve = resolve;
    });

    const respondBidirectionalPromise = new Promise<RespondBidirectionalEvent>(resolve => {
      respondBidirectionalResolve = resolve;
    });

    const chainSignaturesProgram = this.getEventProgram();

    const signatureListener = chainSignaturesProgram.addEventListener(
      'signatureRespondedEvent',
      (event: SignatureRespondedEvent) => {
        const eventRequestId =
          '0x' + Buffer.from(event.requestId).toString('hex');

        if (
          eventRequestId === requestId &&
          event.responder.toBase58() === RESPONDER_ADDRESS
        ) {
          if (!resolvedSignature) {
            resolvedSignature = true;
            signatureResolve(event);
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
          console.warn('Signature event request ID mismatch');
        }
      },
    );

    const respondBidirectionalListener = chainSignaturesProgram.addEventListener(
      'respondBidirectionalEvent',
      (event: RespondBidirectionalEvent) => {
        const eventRequestId =
          '0x' + Buffer.from(event.requestId).toString('hex');

        if (
          eventRequestId === requestId &&
          event.responder.toBase58() === RESPONDER_ADDRESS
        ) {
          if (!resolvedRead) {
            resolvedRead = true;
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
          console.warn('Signature event request ID mismatch');
        }
      },
    );

    const cleanup = () => {
      chainSignaturesProgram.removeEventListener(signatureListener);
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
    try {
      const program = this.getEventProgram();

      const responderPubkey = new PublicKey(RESPONDER_ADDRESS);
      const signatures = await this.eventConnection.getSignaturesForAddress(
        responderPubkey,
        { limit: maxSignatures },
      );

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
                const tx = await this.eventConnection.getTransaction(
                  sig.signature,
                  {
                    maxSupportedTransactionVersion: 0,
                  },
                );
                const logs = tx?.meta?.logMessages ?? [];
                for (const log of logs) {
                  try {
                    const decoded = program.coder.events.decode(log) as {
                      name: string;
                      data: SignatureRespondedEvent | RespondBidirectionalEvent;
                    } | null;
                    if (!decoded) continue;
                    const name = decoded.name as string;
                    if (
                      name === 'signatureRespondedEvent' ||
                      name === 'respondBidirectionalEvent'
                    ) {
                      const eventReq =
                        '0x' +
                        Buffer.from(decoded.data.requestId).toString('hex');
                      if (eventReq !== requestId) continue;
                      if (name === 'signatureRespondedEvent') {
                        onSignature(decoded.data as SignatureRespondedEvent);
                      } else if (name === 'respondBidirectionalEvent') {
                        onrespondBidirectional(decoded.data as RespondBidirectionalEvent);
                      }
                    }
                  } catch {
                    // ignore decode errors per-log
                  }
                }
              } catch {
                // ignore tx fetch errors
              }
            }
          },
        ),
      );
    } catch {
      // ignore overall backfill errors
    }
  }
}
