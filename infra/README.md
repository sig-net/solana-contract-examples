# Solana Bridge Infrastructure

AWS Lambda infrastructure for the Solana Bridge using SST (Serverless Stack).

## Prerequisites

- Node.js 20.x or higher
- pnpm 10.13.1
- AWS CLI configured with credentials
- AWS account with appropriate permissions

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

Create an `.env` file in the `infra` directory with the following variables:

```env
# RPC Endpoints
NEXT_PUBLIC_HELIUS_RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_API_KEY"
NEXT_PUBLIC_ALCHEMY_API_KEY="YOUR_ALCHEMY_API_KEY"

# Private key for relayer (array format)
RELAYER_PRIVATE_KEY="[179,4,195,...]"

# MPC Configuration - Update when changing the signer
# IMPORTANT: These should be included in the code eventually
#
# For FAKENET Signer (Default):
NEXT_PUBLIC_MPC_ROOT_PUBLIC_KEY="0x044eef776e4f257d68983e45b340c2e9546c5df95447900b6aadfec68fb46fdee257e26b8ba383ddba9914b33c60e869265f859566fff4baef283c54d821ca3b64"
NEXT_PUBLIC_MPC_ROOT_ADDRESS="0x00A40C2661293d5134E53Da52951A3F7767836Ef"
NEXT_PUBLIC_MPC_RESPONDER_ADDRESS="8oYvqBeCAhQYhA7Fw2fxG2ZvYgmhUtEdtXhteT7xdbti"

# For LOCAL Signer:
# NEXT_PUBLIC_MPC_ROOT_PUBLIC_KEY="0x04bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4"
# NEXT_PUBLIC_MPC_ROOT_ADDRESS="0x1Be31A94361a391bBaFB2a4CCd704F57dc04d4bb"
# NEXT_PUBLIC_MPC_RESPONDER_ADDRESS="Dewq9xyD1MZi1rE588XZFvK7uUqkcHLgCnDsn9Ns4H9M"

# AWS Configuration
AWS_REGION=us-east-1
SST_STAGE=prod
```

## Deployment

### Production Deployment

Deploy to production:

```bash
./scripts/deploy.sh
```

## Stack Outputs

After deployment, SST will output:

- **NotifyDepositUrl**: Public URL for deposit notifications
- **NotifyWithdrawalUrl**: Public URL for withdrawal notifications
- **NotifyDepositName**: Lambda function name for deposits
- **NotifyWithdrawalName**: Lambda function name for withdrawals

These URLs should be configured in the frontend `.env` file:

```env
NEXT_PUBLIC_NOTIFY_DEPOSIT_URL="https://xxx.lambda-url.us-east-1.on.aws/"
NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL="https://yyy.lambda-url.us-east-1.on.aws/"
```
