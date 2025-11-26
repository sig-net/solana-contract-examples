import { PublicKey } from '@solana/web3.js';

// Chain Signatures Program Types
export interface ChainSignaturesBigR {
  x: number[];
  y: number[];
}

export interface ChainSignaturesSignature {
  bigR: ChainSignaturesBigR;
  s: number[];
  recoveryId: number;
}

export interface SignatureRespondedEvent {
  requestId: number[];
  responder: PublicKey;
  signature: ChainSignaturesSignature;
}

export interface RespondBidirectionalEvent {
  requestId: number[];
  responder: PublicKey;
  serializedOutput: number[];
  signature: ChainSignaturesSignature;
}

// Event Listener Types
export interface EventPromises {
  signature: Promise<SignatureRespondedEvent>;
  respondBidirectional: Promise<RespondBidirectionalEvent>;
  cleanup: () => void;
  backfillSignature: () => Promise<void>;
  backfillRead: () => Promise<void>;
}

// Chain Signatures Program Interface
export interface ChainSignaturesProgram {
  programId: PublicKey;
  coder: {
    events: {
      decode(logMessage: string): {
        name: string;
        data: SignatureRespondedEvent | RespondBidirectionalEvent;
      } | null;
    };
  };
  addEventListener(
    eventName: 'signatureRespondedEvent',
    callback: (event: SignatureRespondedEvent) => void,
  ): unknown;
  addEventListener(
    eventName: 'respondBidirectionalEvent',
    callback: (event: RespondBidirectionalEvent) => void,
  ): unknown;
  removeEventListener(listener: unknown): void;
}
