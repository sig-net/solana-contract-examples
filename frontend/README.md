# Solana Bridge Frontend

A Next.js application for bridging assets between Solana and EVM chains using chain signatures.

## Prerequisites

- Node.js 20.x or higher
- pnpm 10.13.1
- A Solana wallet (Phantom, Solflare, etc.)
- An Ethereum wallet (MetaMask, WalletConnect, etc.)

## Installation

1. Install dependencies:

```bash
pnpm install
```

2. Configure environment variables:

```bash
cp .env.example .env
# Edit .env with your configuration
```

## Environment Configuration

### Required Environment Variables

```env
# RPC Endpoints
NEXT_PUBLIC_HELIUS_RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_API_KEY"
NEXT_PUBLIC_ALCHEMY_API_KEY="YOUR_ALCHEMY_API_KEY"

# Private key for relayer (array format)
RELAYER_PRIVATE_KEY="[179,4,195,...]"

# Notification endpoints (Lambda URLs or local API endpoints)
# For local development:
NEXT_PUBLIC_NOTIFY_DEPOSIT_URL="/api/notify-deposit"
NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL="/api/notify-withdrawal"

# For production (Lambda URLs):
# NEXT_PUBLIC_NOTIFY_DEPOSIT_URL="https://your-lambda-url.amazonaws.com/"
# NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL="https://your-lambda-url.amazonaws.com/"

# MPC Configuration (Chain Signatures)
NEXT_PUBLIC_MPC_ROOT_PUBLIC_KEY="0x044eef776..."
NEXT_PUBLIC_MPC_ROOT_ADDRESS="0x00A40C2661..."
NEXT_PUBLIC_MPC_RESPONDER_ADDRESS="8oYvqBeCAhQYhA7..."
```

### MPC Signer Configuration

**Important:** When switching signers (fakenet/local):

1. Update `lib/constants/addresses.ts`:

```
export const CHAIN_SIGNATURES_CONFIG = {
  MPC_ROOT_PUBLIC_KEY:
    'NEXT_PUBLIC_MPC_ROOT_PUBLIC_KEY',
  ...
} as const;

export const RESPONDER_ADDRESS = 'NEXT_PUBLIC_MPC_RESPONDER_ADDRESS';
```

2. on the `admin` page call the update function with `NEXT_PUBLIC_MPC_ROOT_ADDRESS`

Obs: use the values from the `.env` file, it will be automatic in the future, but now it's manual

**Fakenet (Default - Testing):**

```env
NEXT_PUBLIC_MPC_ROOT_PUBLIC_KEY="0x044eef776e4f257d68983e45b340c2e9546c5df95447900b6aadfec68fb46fdee257e26b8ba383ddba9914b33c60e869265f859566fff4baef283c54d821ca3b64"
NEXT_PUBLIC_MPC_ROOT_ADDRESS="0x00A40C2661293d5134E53Da52951A3F7767836Ef"
NEXT_PUBLIC_MPC_RESPONDER_ADDRESS="8oYvqBeCAhQYhA7Fw2fxG2ZvYgmhUtEdtXhteT7xdbti"
```

**Local (Development):**

```env
NEXT_PUBLIC_MPC_ROOT_PUBLIC_KEY="0x04bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4"
NEXT_PUBLIC_MPC_ROOT_ADDRESS="0x1Be31A94361a391bBaFB2a4CCd704F57dc04d4bb"
NEXT_PUBLIC_MPC_RESPONDER_ADDRESS="Dewq9xyD1MZi1rE588XZFvK7uUqkcHLgCnDsn9Ns4H9M"
```

Switch by commenting/uncommenting in `.env`.

## Development

Start the development server:

```bash
pnpm dev
```

The application will be available at http://localhost:3000
