import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
      retry: (failureCount, error) => {
        if (error instanceof Error && error.message.includes('wallet')) {
          return false;
        }
        return failureCount < 3;
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});

export const queryKeys = {
  solana: {
    all: ['solana'] as const,
    depositAddress: (publicKey: string) =>
      [...queryKeys.solana.all, 'depositAddress', publicKey] as const,
    userBalances: (publicKey: string) =>
      [...queryKeys.solana.all, 'userBalances', publicKey] as const,
    unclaimedBalances: (publicKey: string) =>
      [...queryKeys.solana.all, 'unclaimedBalances', publicKey] as const,
    outgoingTransfers: (publicKey: string) =>
      [...queryKeys.solana.all, 'outgoingTransfers', publicKey] as const,
    incomingDeposits: (publicKey: string) =>
      [...queryKeys.solana.all, 'incomingDeposits', publicKey] as const,
  },
} as const;

export function invalidateBalanceQueries(
  queryClient: QueryClient,
  account: string,
) {
  queryClient.invalidateQueries({
    queryKey: queryKeys.solana.userBalances(account),
  });
  queryClient.invalidateQueries({
    queryKey: queryKeys.solana.unclaimedBalances(account),
  });
}

export function invalidateDepositQueries(
  queryClient: QueryClient,
  account: string,
) {
  invalidateBalanceQueries(queryClient, account);
  queryClient.invalidateQueries({
    queryKey: queryKeys.solana.incomingDeposits(account),
  });
}

export function invalidateWithdrawalQueries(
  queryClient: QueryClient,
  account: string,
) {
  invalidateBalanceQueries(queryClient, account);
  queryClient.invalidateQueries({
    queryKey: queryKeys.solana.outgoingTransfers(account),
  });
}
