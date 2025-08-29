import { z } from 'zod';

/**
 * Environment variable configuration
 * Single source of truth for all env vars across the application
 */

// Client-side environment variables (accessible in browser)
const clientEnvSchema = z.object({
  NEXT_PUBLIC_ALCHEMY_API_KEY: z.string().min(1, 'Alchemy API key is required'),
  NEXT_PUBLIC_HELIUS_RPC_URL: z.string().optional(),
  NEXT_PUBLIC_NOTIFY_DEPOSIT_URL: z.string().optional(),
  NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL: z.string().optional(),
  NEXT_PUBLIC_CHAIN_SIGNATURES_PROGRAM_ID: z
    .string()
    .min(1, 'Chain signatures program ID is required'),
  NEXT_PUBLIC_RESPONDER_ADDRESS: z
    .string()
    .min(1, 'Responder address is required'),
  NEXT_PUBLIC_BASE_PUBLIC_KEY: z.string().min(1, 'Base public key is required'),
});

// Server-side only environment variables
const serverEnvSchema = z.object({
  RELAYER_PRIVATE_KEY: z.string().min(1, 'Relayer private key is required'),
});

// Full environment schema (client + server)
const fullEnvSchema = clientEnvSchema.merge(serverEnvSchema);

// Type exports
export type ClientEnv = z.infer<typeof clientEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type FullEnv = z.infer<typeof fullEnvSchema>;

/**
 * Get and validate client environment variables
 * Can be called from both client and server
 */
export function getClientEnv(): ClientEnv {
  const rawEnv: Record<string, string | undefined> = {
    NEXT_PUBLIC_ALCHEMY_API_KEY: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY,
    NEXT_PUBLIC_HELIUS_RPC_URL: process.env.NEXT_PUBLIC_HELIUS_RPC_URL,
    NEXT_PUBLIC_NOTIFY_DEPOSIT_URL: process.env.NEXT_PUBLIC_NOTIFY_DEPOSIT_URL,
    NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL:
      process.env.NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL,
    NEXT_PUBLIC_CHAIN_SIGNATURES_PROGRAM_ID:
      process.env.NEXT_PUBLIC_CHAIN_SIGNATURES_PROGRAM_ID,
    NEXT_PUBLIC_RESPONDER_ADDRESS: process.env.NEXT_PUBLIC_RESPONDER_ADDRESS,
    NEXT_PUBLIC_BASE_PUBLIC_KEY: process.env.NEXT_PUBLIC_BASE_PUBLIC_KEY,
  };

  try {
    return clientEnvSchema.parse(rawEnv);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.issues
        .map(err => `${err.path.join('.')}: ${err.message}`)
        .join(', ');
      throw new Error(`Client environment validation failed: ${missingVars}`);
    }
    throw error;
  }
}

/**
 * Get and validate full environment variables (server-side only)
 * Throws error if called from client
 */
export function getFullEnv(): FullEnv {
  if (typeof window !== 'undefined') {
    throw new Error('getFullEnv() should only be called on the server side');
  }

  const rawEnv: Record<string, string | undefined> = {
    NEXT_PUBLIC_ALCHEMY_API_KEY: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY,
    NEXT_PUBLIC_HELIUS_RPC_URL: process.env.NEXT_PUBLIC_HELIUS_RPC_URL,
    NEXT_PUBLIC_NOTIFY_DEPOSIT_URL: process.env.NEXT_PUBLIC_NOTIFY_DEPOSIT_URL,
    NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL:
      process.env.NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL,
    NEXT_PUBLIC_CHAIN_SIGNATURES_PROGRAM_ID:
      process.env.NEXT_PUBLIC_CHAIN_SIGNATURES_PROGRAM_ID,
    NEXT_PUBLIC_RESPONDER_ADDRESS: process.env.NEXT_PUBLIC_RESPONDER_ADDRESS,
    NEXT_PUBLIC_BASE_PUBLIC_KEY: process.env.NEXT_PUBLIC_BASE_PUBLIC_KEY,
    RELAYER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY,
  };

  try {
    return fullEnvSchema.parse(rawEnv);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.issues
        .map(err => `${err.path.join('.')}: ${err.message}`)
        .join(', ');
      throw new Error(`Environment validation failed: ${missingVars}`);
    }
    throw error;
  }
}

/**
 * Get environment variables for SST Lambda configuration
 * Only returns env vars that Lambda functions actually need
 * (NOTIFY URLs are outputs from SST, not inputs)
 */
export function getEnvForSST(): Record<string, string> {
  return {
    NEXT_PUBLIC_ALCHEMY_API_KEY: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ?? '',
    NEXT_PUBLIC_HELIUS_RPC_URL: process.env.NEXT_PUBLIC_HELIUS_RPC_URL ?? '',
    NEXT_PUBLIC_CHAIN_SIGNATURES_PROGRAM_ID:
      process.env.NEXT_PUBLIC_CHAIN_SIGNATURES_PROGRAM_ID ?? '',
    NEXT_PUBLIC_RESPONDER_ADDRESS:
      process.env.NEXT_PUBLIC_RESPONDER_ADDRESS ?? '',
    NEXT_PUBLIC_BASE_PUBLIC_KEY: process.env.NEXT_PUBLIC_BASE_PUBLIC_KEY ?? '',
    RELAYER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY ?? '',
  };
}
