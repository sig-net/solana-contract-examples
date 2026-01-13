'use client';

import { createContext, useContext, useMemo } from 'react';
import { Connection, ConnectionConfig } from '@solana/web3.js';

interface ConnectionContextState {
  connection: Connection;
}

const ConnectionContext = createContext<ConnectionContextState | null>(null);

interface ConnectionProviderProps {
  endpoint: string;
  config?: ConnectionConfig;
  children: React.ReactNode;
}

export function ConnectionProvider({
  endpoint,
  config,
  children,
}: ConnectionProviderProps) {
  const connection = useMemo(
    () => new Connection(endpoint, config),
    [endpoint, config],
  );

  return (
    <ConnectionContext.Provider value={{ connection }}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnection(): ConnectionContextState {
  const context = useContext(ConnectionContext);
  if (!context) {
    throw new Error('useConnection must be used within a ConnectionProvider');
  }
  return context;
}
