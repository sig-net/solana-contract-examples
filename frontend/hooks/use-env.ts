'use client';

import { getClientEnv, type ClientEnv } from '@/lib/config/env.config';

export function useEnv(): ClientEnv {
  return getClientEnv();
}
