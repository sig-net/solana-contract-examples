# Deployment

## Quick Start

```bash
# Interactive deployment
./deploy.sh

# Direct deployment
./deploy.sh dev   # Development
./deploy.sh prod  # Production
```

## First Time Setup

1. **Generate keypairs:**
   ```bash
   cd contract/deploy/scripts
   ./setup-keys.sh
   ```

2. **Configure AWS (optional):**
   ```bash
   aws configure
   ```

3. **Set environment variables:**
   - Edit `infra/.env.dev` and `infra/.env.prod`

## What Happens

The deployment script:
1. Deploys Solana program to selected environment
2. Syncs configuration to frontend
3. Deploys SST infrastructure (if AWS configured)
4. Updates all environment files automatically

## Program Addresses

- **Dev:** `AD14xJzkNHHFxMRitSe7ZuZvG9BeBPd9sqeVnWSxri9V`
- **Prod:** `vEsxyM3N6yXpJJwzWS1fv3C9xohNSfMFZgpPh4Uw15n`

## Troubleshooting

```bash
# Check Solana balance
solana balance

# Get testnet SOL
solana airdrop 2

# Check program
solana program show <PROGRAM_ID> --url devnet

# SST logs
cd infra && pnpm sst console --stage dev
```