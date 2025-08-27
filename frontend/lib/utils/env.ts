import { z } from 'zod';

const clientEnvSchema = z.object({
  NEXT_PUBLIC_ALCHEMY_API_KEY: z.string().min(1, 'Alchemy API key is required'),
  NEXT_PUBLIC_HELIUS_RPC_URL: z.string().optional(),
  NEXT_PUBLIC_NOTIFY_DEPOSIT_URL: z.string().optional(),
  NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL: z.string().optional(),
});

const serverEnvSchema = z.object({
  RELAYER_PRIVATE_KEY: z.string().min(1, 'Relayer private key is required'),
});

const fullEnvSchema = clientEnvSchema.merge(serverEnvSchema);

export type ClientEnv = z.infer<typeof clientEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type FullEnv = z.infer<typeof fullEnvSchema>;

export function getClientEnv(): ClientEnv {
  const rawEnv = {
    NEXT_PUBLIC_ALCHEMY_API_KEY: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY,
    NEXT_PUBLIC_HELIUS_RPC_URL: process.env.NEXT_PUBLIC_HELIUS_RPC_URL,
    NEXT_PUBLIC_NOTIFY_DEPOSIT_URL: process.env.NEXT_PUBLIC_NOTIFY_DEPOSIT_URL,
    NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL:
      process.env.NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL,
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

export function getFullEnv(): FullEnv {
  if (typeof window !== 'undefined') {
    throw new Error('getFullEnv() should only be called on the server side');
  }

  const rawEnv = {
    NEXT_PUBLIC_ALCHEMY_API_KEY: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY,
    NEXT_PUBLIC_HELIUS_RPC_URL: process.env.NEXT_PUBLIC_HELIUS_RPC_URL,
    NEXT_PUBLIC_NOTIFY_DEPOSIT_URL: process.env.NEXT_PUBLIC_NOTIFY_DEPOSIT_URL,
    NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL:
      process.env.NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL,
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
