# CLAUDE.md

This file provides guidance to Claude Code when working with code in the `contract/` directory.

## Build & Development Commands

```bash
anchor build          # Build the Solana program
anchor test           # Build + run all tests (ETH and BTC)
yarn lint             # Prettier check
yarn lint:fix         # Prettier auto-fix
```

## Testing

Tests are **long-running and verbose** (timeout is set to 1,000,000ms). Always run tests in a **background Bash task** and peek into the output to check progress and logs.

Anchor reads the RPC URL and wallet from `solana config` — no need to set `ANCHOR_PROVIDER_URL` or `ANCHOR_WALLET` env vars. Verify with `solana config get`.

ETH and BTC test suites must be run **separately** — never run both at the same time.

Use `--skip-deploy` since the program is already deployed on devnet.

### Running ETH tests

```bash
# Run in background via Bash tool with run_in_background: true
anchor test --skip-deploy -- --grep "ERC20"
```

### Running BTC tests

```bash
# Run in background via Bash tool with run_in_background: true
anchor test --skip-deploy -- --grep "BTC"
```

### How to monitor

After launching a background task, use `TaskOutput` with `block: false` (or `Read` on the output file) to periodically check progress without blocking.

### Test structure

- `tests/sign-respond-erc20.ts` — ERC20 deposit, withdraw, and refund flows
- `tests/bitcoin/happy-path.ts` — BTC deposit and withdrawal happy path
- `tests/bitcoin/sad-path.ts` — BTC error cases and validation
- `tests/bitcoin/double-spend-conflict.ts` — BTC double-spend conflict handling
- `tests/bitcoin/utils.ts` — Shared BTC test utilities

## Architecture Overview

Anchor-based Solana program implementing cross-chain vault operations for ERC20 tokens (via EVM/Sepolia) and BTC using MPC signatures from the Chain Signatures protocol.

### Program Structure

- `programs/solana-contracts-examples/src/lib.rs` — Entrypoint with all instruction handlers
- `src/instructions/erc20_vault.rs` — ERC20 deposit, claim, withdraw, complete-withdraw logic
- `src/instructions/btc_vault.rs` — BTC deposit, claim, withdraw, complete-withdraw logic
- `src/contexts/` — Anchor account contexts (config, erc20, btc)
- `src/state/` — Account state definitions (config, erc20, btc)
- `src/crypto.rs` — Signature verification utilities
- `src/error.rs` — Custom error definitions
- `src/constants.rs` — Program constants

### Environment

Configuration loaded via `utils/envConfig.ts` with Zod validation. Requires a `.env` file with:

- `INFURA_API_KEY` — Sepolia RPC access
- `CHAIN_SIGNATURES_PROGRAM_ID` — On-chain MPC program
- `MPC_ROOT_PRIVATE_KEY` or `MPC_ROOT_PUBLIC_KEY` — MPC root key
- `SOLANA_RPC_URL` — Solana cluster endpoint
- `SOLANA_PRIVATE_KEY` — Test wallet key

## Before Completing Any Task

```bash
yarn lint
```
