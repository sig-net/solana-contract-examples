# Contract Workspace

## Prerequisites

- Install dependencies: `yarn install`
- Copy `.env.example` to `.env` and configure:
  - `MPC_ROOT_KEY` or `BASE_PUBLIC_KEY`
  - `SOLANA_RPC_URL`, `SOLANA_PRIVATE_KEY`
  - `BITCOIN_NETWORK` (regtest/testnet/mainnet)
  - `INFURA_API_KEY` for EVM chains

### Bitcoin Setup (Regtest)

For local Bitcoin testing with instant block mining:

```bash
# Clone the Bitcoin regtest repository
git clone https://github.com/Pessina/bitcoin-regtest.git
cd bitcoin-regtest

# Start Bitcoin Core in regtest mode
yarn docker:dev

# Bitcoin RPC will be available at: http://localhost:18443
# Web UI at: http://localhost:5173
```

Set in `.env`:
```
BITCOIN_NETWORK=regtest
```

**Network Options:**
- `regtest` - Local Bitcoin Core (addresses: `bcrt1q...`) - Auto-mines blocks, instant funding
- `testnet` - Bitcoin testnet4 (addresses: `tb1q...`) - Requires external faucet
- `mainnet` - Bitcoin mainnet (addresses: `bc1q...`) - Production use only

## Build, Type Check, and Test

- Compile programs: `anchor build`
- Deploy to devnet: `anchor deploy --provider.cluster devnet`
- Type check and lint: `yarn lint`
- Run tests: `anchor test --skip-build --skip-deploy`
- The TypeScript integration tests automatically ensure the on-chain `vault_config`
  account is initialized with the derived MPC root signer. If the account already
  exists with the correct key, the setup skips re-initialization.

## Key Management

- If you have access to the private key, set `MPC_ROOT_PRIVATE_KEY`; the root public key is derived automatically.
- If the private key is unavailable, provide the uncompressed key in `MPC_ROOT_PUBLIC_KEY` (65-byte hex, prefixed with `04`).
- Ensure the on-chain contract is initialized with the same base public key you load here before interacting with it.
