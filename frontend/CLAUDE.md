# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
pnpm dev          # Start dev server with Turbopack
pnpm build        # Production build
pnpm lint         # ESLint check
pnpm lint:fix     # ESLint auto-fix
pnpm typecheck    # TypeScript type checking
pnpm format       # Prettier check
pnpm format:fix   # Prettier format
```

## Architecture Overview

This is a cross-chain bridge frontend enabling asset transfers between Solana and EVM chains using MPC (Multi-Party Computation) signatures via the Chain Signatures protocol.

### Provider Hierarchy

```
QueryClientProvider (TanStack Query)
  └── WagmiProvider (EVM wallets)
       └── ConnectionProvider (Solana RPC)
            └── AppProvider (@solana/connector)
                 └── App
```

### Data Flow Architecture

```
Components → Hooks → Services → Contracts → Blockchain
                        ↓
                  CrossChainOrchestrator
                        ↓
            ┌──────────┴──────────┐
      BridgeContract    ChainSignaturesContract
            ↓                    ↓
    Anchor Program         MPC Signing
```

### Key Architectural Patterns

**Service Layer** (`lib/services/`):
- `CrossChainOrchestrator` - Coordinates multi-step cross-chain transactions
- `DepositService` / `WithdrawalService` - Handle specific operations
- `TokenBalanceService` - Manages on-chain balance queries

**Contract Clients** (`lib/contracts/`):
- `BridgeContract` - Wraps Anchor program methods (deposit, claim, withdraw)
- `ChainSignaturesContract` - Handles MPC signature events and verification

**Relayer Handlers** (`lib/relayer/handlers.ts`):
- Server-side execution of cross-chain flows
- Called via Next.js API routes (`/api/notify-deposit`, `/api/notify-withdrawal`)

### Cross-Chain Flow

1. **Deposit**: User deposits ERC20 → Relayer detects → Calls `depositErc20` on Solana → MPC signs → EVM tx executes → `claimErc20` completes
2. **Withdraw**: User calls `withdrawErc20` → MPC signs → EVM tx executes → `completeWithdrawErc20` finalizes

### PDA Derivation

All Program Derived Addresses are centralized in `lib/constants/addresses.ts`:
- `deriveVaultAuthorityPda(userPublicKey)` - Per-user vault
- `derivePendingDepositPda(requestIdBytes)` - Pending deposit accounts
- `derivePendingWithdrawalPda(requestIdBytes)` - Pending withdrawal accounts
- `deriveUserBalancePda(userPublicKey, erc20AddressBytes)` - User token balances
- `deriveEthereumAddress(path, requesterAddress, basePublicKey)` - Derives EVM address from MPC key

### Query Keys

React Query keys are centralized in `lib/query-client.ts` via `queryKeys` object. Always use these for cache invalidation.

## Environment Configuration

Environment variables are validated via Zod in `lib/config/env.config.ts`:
- `getClientEnv()` - Client-safe vars (NEXT_PUBLIC_*)
- `getFullEnv()` - Server-side only (includes RELAYER_PRIVATE_KEY)

Required variables:
- `NEXT_PUBLIC_ALCHEMY_API_KEY` - Alchemy RPC
- `NEXT_PUBLIC_CHAIN_SIGNATURES_PROGRAM_ID` - MPC program ID
- `NEXT_PUBLIC_RESPONDER_ADDRESS` - Solana responder
- `NEXT_PUBLIC_BASE_PUBLIC_KEY` - MPC root public key
- `RELAYER_PRIVATE_KEY` - Server-side relayer key (JSON array format)

## Tech Stack

- **Next.js 16** with Turbopack, React 19, React Compiler
- **TailwindCSS 4** with Radix UI primitives
- **TanStack Query** for server state
- **wagmi/viem** for EVM interactions
- **@solana/connector** for Solana wallet (headless)
- **@coral-xyz/anchor** for Solana program interaction
- **Zod** for runtime validation

## Code Conventions

- Path alias: `@/*` maps to project root
- Unused variables must be prefixed with `_`
- TypeScript strict mode with `noUncheckedIndexedAccess`
- All pages are client components (`'use client'`) with `export const dynamic = 'force-dynamic'`

## React Compiler

This project uses React Compiler (`babel-plugin-react-compiler`). ESLint enforces compiler rules via `react-compiler/react-compiler: error`.

**Do not use `useMemo`, `useCallback`, or `React.memo`** - the compiler handles memoization automatically.

## Before Completing Any Task

Always run these commands and fix any errors before finishing:

```bash
pnpm lint && pnpm typecheck && pnpm build
```
