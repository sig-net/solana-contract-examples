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
INFURA_API_KEY="YOUR_INFURA_API_KEY"

# Private key for relayer (array format)
RELAYER_PRIVATE_KEY="[179,4,195,...]"

# Notification endpoints
NEXT_PUBLIC_NOTIFY_DEPOSIT_URL="/api/notify-deposit"
NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL="/api/notify-withdrawal"

# Solana Program IDs
NEXT_PUBLIC_CHAIN_SIGNATURES_PROGRAM_ID="YOUR_CHAIN_SIGNATURES_PROGRAM_ID"

# MPC Configuration (Chain Signatures)
NEXT_PUBLIC_MPC_ROOT_PUBLIC_KEY="0x04..."
NEXT_PUBLIC_RESPONDER_ADDRESS="YOUR_RESPONDER_ADDRESS"

# Optional: Embedded signer (for local development)
MPC_ROOT_KEY="0x..."
```

### MPC Signer Configuration

**Important:** When switching signers (fakenet/local), update the MPC configuration values in `.env`.

**Local (Development):**

```env
NEXT_PUBLIC_MPC_ROOT_PUBLIC_KEY="0x04bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4"
NEXT_PUBLIC_RESPONDER_ADDRESS="Dewq9xyD1MZi1rE588XZFvK7uUqkcHLgCnDsn9Ns4H9M"
```

Switch by commenting/uncommenting in `.env`.

## Development

Start the development server:

```bash
pnpm dev
```

The application will be available at <http://localhost:3000>
