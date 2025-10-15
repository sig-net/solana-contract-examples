# Contract Workspace

## Prerequisites

- Install dependencies: `yarn install`
- Copy `.env.example` to `.env` and provide either `MPC_ROOT_KEY` or `BASE_PUBLIC_KEY`
- Set `SOLANA_RPC_URL`, `SOLANA_PRIVATE_KEY`, and other required variables

## Build, Type Check, and Test

- Compile programs: `anchor build`
- Type check and lint: `yarn lint`
- Run the Anchor test suite: `yarn test`
- The TypeScript integration tests automatically ensure the on-chain `vault_config`
  account is initialized with the derived MPC root signer. If the account already
  exists with the correct key, the setup skips re-initialization.

## Key Management

- If you have access to the private key, set `MPC_ROOT_KEY`; the base public key is derived automatically.
- If the private key is unavailable, provide the uncompressed key in `BASE_PUBLIC_KEY` (65-byte hex, prefixed with `04`).
- Ensure the on-chain contract is initialized with the same base public key you load here before interacting with it.
