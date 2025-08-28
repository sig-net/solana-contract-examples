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

## Building and Production

Build the application:
```bash
pnpm build
```

Start the production server:
```bash
pnpm start
```

## Scripts

- `pnpm dev` - Start development server with Turbo
- `pnpm build` - Build for production
- `pnpm start` - Start production server
- `pnpm lint` - Run ESLint
- `pnpm lint:fix` - Fix ESLint issues
- `pnpm format` - Check code formatting
- `pnpm format:fix` - Fix code formatting

## Admin Panel

Access at: **http://localhost:3000/admin**

### Setup Steps

1. Navigate to http://localhost:3000/admin
2. Connect your Solana wallet
3. Enter the MPC Root Address:
   - **For Fakenet**: `0x00A40C2661293d5134E53Da52951A3F7767836Ef`
   - **For Local**: `0x1Be31A94361a391bBaFB2a4CCd704F57dc04d4bb`
4. Click "Initialize" (first time) or "Update" (to change)

The admin panel updates the on-chain MPC signer configuration that controls bridge operations.

## Features

- Bridge SPL and ERC-20 tokens between Solana and EVM chains
- Multi-wallet support (Phantom, MetaMask, WalletConnect)
- Real-time transaction tracking
- Admin panel for MPC configuration
- QR codes for deposit addresses

## Troubleshooting

- **Connection Issues**: Verify RPC URLs and API keys
- **Transaction Failures**: Check SOL/ETH balance for gas
- **MPC Errors**: Confirm correct signer in `.env` and admin panel
- **Lambda Timeouts**: Use local API endpoints for development

## Security

- Never commit private keys
- Test on devnet before mainnet
- Verify MPC addresses match between `.env` and admin panel
