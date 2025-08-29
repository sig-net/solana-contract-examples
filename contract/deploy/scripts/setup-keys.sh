#!/bin/bash

set -e

DEPLOY_DIR="$(dirname "$(dirname "${BASH_SOURCE[0]}")")"

echo "==================================="
echo "  Keypair Setup"
echo "==================================="
echo ""

# Generate keypair if doesn't exist
generate() {
    local path=$1
    local name=$2
    
    if [ ! -f "$path" ]; then
        echo "Creating $name keypair..."
        solana-keygen new --outfile "$path" --no-bip39-passphrase
    fi
    echo "$name: $(solana-keygen pubkey "$path")"
}

# Generate program keypairs
generate "$DEPLOY_DIR/keypairs/dev-program.json" "Dev"
generate "$DEPLOY_DIR/keypairs/prod-program.json" "Prod"

echo ""
echo "✅ Setup complete"
echo ""
echo "Deploy with: ./deploy.sh"