'use client';

import { useMemo } from 'react';
import { z } from 'zod';

const envSchema = z.object({
  NEXT_PUBLIC_ALCHEMY_API_KEY: z.string().min(1, 'Alchemy API key is required'),
  NEXT_PUBLIC_SEPOLIA_RPC_URL: z.string().optional(),
  NEXT_PUBLIC_SOLANA_RPC_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function useEnv(): Env {
  return useMemo(() => {
    const rawEnv = {
      NEXT_PUBLIC_ALCHEMY_API_KEY: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY,
      NEXT_PUBLIC_SEPOLIA_RPC_URL: process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL,
      NEXT_PUBLIC_SOLANA_RPC_URL: process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
    };

    try {
      return envSchema.parse(rawEnv);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const missingVars = error.issues
          .map(err => `${err.path.join('.')}: ${err.message}`)
          .join(', ');
        throw new Error(`Environment validation failed: ${missingVars}`);
      }
      throw error;
    }
  }, []);
}
