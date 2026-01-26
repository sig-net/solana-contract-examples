import { Connection, PublicKey } from '@solana/web3.js';
import {
  Program,
  AnchorProvider,
  Wallet,
  utils as anchorUtils,
  EventParser,
} from '@coral-xyz/anchor';
import { contracts } from 'signet.js';
import type { Hex } from 'viem';

import { CHAIN_SIGNATURES_PROGRAM_IDL } from '@/lib/program/idl-chain-sig';
import { getClientEnv } from '@/lib/config/env.config';

// CPI emit discriminator used by Anchor's emit_cpi! macro
const EMIT_CPI_INSTRUCTION_DISCRIMINATOR = Buffer.from([
  228, 69, 165, 46, 81, 203, 154, 29,
]);

import type {
  ChainSignaturesProgram,
  ChainSignaturesSignature,
  SignatureRespondedEvent,
  RespondBidirectionalEvent,
  EventPromises,
} from '../types/chain-signatures.types';
import {
  RESPONDER_ADDRESS,
  CHAIN_SIGNATURES_PROGRAM_ID,
} from '../constants/addresses';

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

  async setupEventListeners(requestId: string): Promise<EventPromises> {
    console.log('[EVENT] Setting up event listeners for requestId:', requestId);
    console.log('[EVENT] Expected responder:', RESPONDER_ADDRESS);

    let signatureResolve: (value: SignatureRespondedEvent) => void;
    let respondBidirectionalResolve: (value: RespondBidirectionalEvent) => void;
    let resolvedSignature = false;
    let resolvedRead = false;
    let signetUnsubscribe: (() => Promise<void>) | null = null;

    const signaturePromise = new Promise<SignatureRespondedEvent>(resolve => {
      signatureResolve = resolve;
    });

    const respondBidirectionalPromise = new Promise<RespondBidirectionalEvent>(
      resolve => {
        respondBidirectionalResolve = resolve;
      },
    );

    const chainSignaturesProgram = this.getEventProgram();
    const eventProvider = new AnchorProvider(
      this.eventConnection,
      this.wallet,
      {
        commitment: 'confirmed',
      },
    );

    const signetContract = new contracts.solana.ChainSignatureContract({
      provider: eventProvider,
      programId: CHAIN_SIGNATURES_PROGRAM_ID,
      config: {
        rootPublicKey: this.getRootPublicKeyForSignet(),
      },
    });

    // Await the subscription to ensure it's established before returning
    try {
      signetUnsubscribe = await signetContract.subscribeToEvents({
        onSignatureResponded: (event, slot) => {
          const eventRequestId =
            '0x' + Buffer.from(event.requestId).toString('hex');
          const eventResponder = event.responder.toBase58();

          console.log(
            '[EVENT] signatureRespondedEvent received via signet.js:',
            {
              eventRequestId,
              expectedRequestId: requestId,
              eventResponder,
              expectedResponder: RESPONDER_ADDRESS,
              slot,
              requestIdMatch: eventRequestId === requestId,
              responderMatch: eventResponder === RESPONDER_ADDRESS,
            },
          );

          if (
            eventRequestId === requestId &&
            eventResponder === RESPONDER_ADDRESS
          ) {
            if (!resolvedSignature) {
              resolvedSignature = true;
              console.log(
                '[EVENT] Signature event matched! Resolving promise...',
              );
              signatureResolve(event as SignatureRespondedEvent);
            }
          } else {
            console.warn('[EVENT] Signature event mismatch - ignoring');
          }
        },
        onSignatureError: (event, slot) => {
          const eventRequestId =
            '0x' + Buffer.from(event.requestId).toString('hex');
          console.error('[EVENT] signatureErrorEvent received:', {
            eventRequestId,
            expectedRequestId: requestId,
            slot,
            error: event.error,
          });
        },
      });
      console.log('[EVENT] signet.js subscription established');
    } catch (err) {
      console.error('[EVENT] Failed to subscribe via signet.js:', err);
    }

    const respondBidirectionalListener =
      chainSignaturesProgram.addEventListener(
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

          if (
            eventRequestId === requestId &&
            eventResponder === RESPONDER_ADDRESS
          ) {
            if (!resolvedRead) {
              resolvedRead = true;
              console.log(
                '[EVENT] RespondBidirectional event matched! Resolving promise...',
              );
              respondBidirectionalResolve(event);
            }
          } else {
            console.warn(
              '[EVENT] RespondBidirectional event mismatch - ignoring',
            );
          }
        },
      );

    console.log('[EVENT] Listeners registered:', {
      signetSubscription: 'established',
      respondBidirectionalListenerId: respondBidirectionalListener,
    });

    const cleanup = () => {
      if (signetUnsubscribe) {
        signetUnsubscribe().catch(err => {
          console.error('[EVENT] Error unsubscribing from signet.js:', err);
        });
      }
      chainSignaturesProgram.removeEventListener(respondBidirectionalListener);
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

    // Allow a small stabilization period for WebSocket connections to fully establish
    // This helps prevent race conditions where events fire before the connection is ready
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('[EVENT] Stabilization period complete, listeners ready');

    // Run immediate backfill to catch any events that fired during setup
    console.log('[EVENT] Running immediate backfill after stabilization...');
    await Promise.all([backfillSignature(), backfillRead()]);
    console.log('[EVENT] Immediate backfill complete');

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

  /**
   * Parse CPI events from a transaction's inner instructions.
   * Events emitted via emit_cpi! are embedded in inner instructions, not logs.
   */
  private parseCpiEventsFromTx(
    tx: Awaited<ReturnType<Connection['getParsedTransaction']>>,
    program: ChainSignaturesProgram,
  ): Array<{ name: string; data: SignatureRespondedEvent | RespondBidirectionalEvent }> {
    const events: Array<{ name: string; data: SignatureRespondedEvent | RespondBidirectionalEvent }> = [];

    if (!tx?.meta?.innerInstructions) return events;

    const programIdStr = program.programId.toString();

    for (const innerIxSet of tx.meta.innerInstructions) {
      for (const instruction of innerIxSet.instructions) {
        // Check if this is a parsed instruction with programId and data
        if (!('programId' in instruction) || !('data' in instruction)) continue;
        if (instruction.programId.toString() !== programIdStr) continue;

        try {
          // Decode the instruction data from base58
          const ixData = anchorUtils.bytes.bs58.decode(instruction.data as string);
          if (ixData.length < 16) continue;

          // Check for CPI discriminator (first 8 bytes)
          const ixDiscriminator = ixData.subarray(0, 8);
          if (Buffer.compare(ixDiscriminator, EMIT_CPI_INSTRUCTION_DISCRIMINATOR) !== 0) continue;

          // Check event discriminator (bytes 8-16) matches a known event
          const eventDiscriminator = ixData.subarray(8, 16);
          const matchingEvent = CHAIN_SIGNATURES_PROGRAM_IDL.events?.find(event => {
            const idlDiscriminator = Buffer.from(event.discriminator);
            return Buffer.compare(eventDiscriminator, idlDiscriminator) === 0;
          });
          if (!matchingEvent) continue;

          // Decode the event data (skip the 8-byte instruction discriminator)
          const fullEventData = ixData.subarray(8);
          const decoded = program.coder.events.decode(
            anchorUtils.bytes.base64.encode(fullEventData),
          ) as { name: string; data: SignatureRespondedEvent | RespondBidirectionalEvent } | null;

          if (decoded) {
            events.push(decoded);
          }
        } catch {
          // Ignore decode errors for individual instructions
        }
      }
    }

    return events;
  }

  /**
   * Parse regular log-based events using Anchor's EventParser.
   */
  private parseLogEvents(
    logs: string[],
    program: ChainSignaturesProgram,
  ): Array<{ name: string; data: SignatureRespondedEvent | RespondBidirectionalEvent }> {
    const events: Array<{ name: string; data: SignatureRespondedEvent | RespondBidirectionalEvent }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parser = new EventParser(program.programId, program.coder as any);

    for (const evt of parser.parseLogs(logs)) {
      if (evt) {
        events.push(evt as { name: string; data: SignatureRespondedEvent | RespondBidirectionalEvent });
      }
    }

    return events;
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
      console.log(
        '[BACKFILL] Fetching signatures for responder:',
        responderPubkey.toBase58(),
      );
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

                // Use getParsedTransaction to get inner instructions for CPI events
                const tx = await this.eventConnection.getParsedTransaction(
                  sig.signature,
                  {
                    commitment: 'confirmed',
                    maxSupportedTransactionVersion: 0,
                  },
                );

                if (!tx) continue;

                // Parse CPI events from inner instructions (emit_cpi! pattern)
                const cpiEvents = this.parseCpiEventsFromTx(tx, program);
                console.log('[BACKFILL] Found', cpiEvents.length, 'CPI events');

                // Also parse regular log events as fallback
                const logs = tx.meta?.logMessages ?? [];
                const logEvents = this.parseLogEvents(logs, program);
                console.log('[BACKFILL] Found', logEvents.length, 'log events');

                // Process all events
                const allEvents = [...cpiEvents, ...logEvents];
                for (const decoded of allEvents) {
                  const name = decoded.name;
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
                    console.log(
                      '[BACKFILL] Event requestId:',
                      eventReq,
                      'expected:',
                      requestId,
                    );
                    if (eventReq !== requestId) continue;

                    if (
                      name === 'signatureRespondedEvent' ||
                      name === 'SignatureRespondedEvent'
                    ) {
                      console.log('[BACKFILL] Found matching signature event!');
                      onSignature(decoded.data as SignatureRespondedEvent);
                    } else if (
                      name === 'respondBidirectionalEvent' ||
                      name === 'RespondBidirectionalEvent'
                    ) {
                      console.log(
                        '[BACKFILL] Found matching respondBidirectional event!',
                      );
                      onrespondBidirectional(
                        decoded.data as RespondBidirectionalEvent,
                      );
                    }
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
