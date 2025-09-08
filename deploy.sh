#!/bin/bash

set -e

# Main deployment script

PROJECT_ROOT="$(pwd)"

# Menu
show_menu() {
    echo "==================================="
    echo "  Deployment System"
    echo "==================================="
    echo ""
    echo "Select environment:"
    echo "  1) Development"
    echo "  2) Production"
    echo "  3) Cancel"
    echo ""
}

# Get environment
if [ -n "$1" ]; then
    ENV=$1
else
    show_menu
    read -p "Enter choice [1-3]: " choice
    case $choice in
        1) ENV="dev" ;;
        2) ENV="prod" ;;
        *) echo "Cancelled"; exit 0 ;;
    esac
fi

echo ""
echo "Deploying to $(echo "$ENV" | tr '[:lower:]' '[:upper:]')"
echo ""

# Prod confirmation
if [ "$ENV" = "prod" ]; then
    echo "⚠️  PRODUCTION DEPLOYMENT"
    read -p "Type 'yes' to continue: " confirm
    [ "$confirm" != "yes" ] && exit 0
fi

# Contract deployment menu
show_contract_menu() {
    echo "==================================="
    echo "  Contract Deployment Options"
    echo "==================================="
    echo ""
    echo "Select contract action:"
    echo "  1) Build and Deploy Contract"
    echo "  2) Build Only (no deployment)"
    echo "  3) Skip Contract (SST only)"
    echo "  4) Cancel"
    echo ""
}

# Get contract deployment choice
if [ -n "$2" ]; then
    CONTRACT_ACTION=$2
else
    show_contract_menu
    read -p "Enter choice [1-4]: " choice
    case $choice in
        1) CONTRACT_ACTION="deploy" ;;
        2) CONTRACT_ACTION="build" ;;
        3) CONTRACT_ACTION="skip" ;;
        *) echo "Cancelled"; exit 0 ;;
    esac
fi

# === SOLANA CONTRACT HANDLING ===
if [ "$CONTRACT_ACTION" != "skip" ]; then
    echo "[ Solana Contract ]"
    
    # Set paths
    PROGRAM_KEYPAIR="contract/deploy/keypairs/${ENV}-program.json"
    if [ ! -f "$PROGRAM_KEYPAIR" ]; then
        echo "Error: Keypairs not found"
        echo "Run: cd contract/deploy/scripts && ./setup-keys.sh"
        exit 1
    fi
    
    PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
    
    # Check balance only if deploying
    if [ "$CONTRACT_ACTION" = "deploy" ]; then
        BALANCE=$(solana balance | awk '{print $1}')
        if (( $(echo "$BALANCE < 0.5" | bc -l) )); then
            echo "Error: Low balance ($BALANCE SOL)"
            echo "Run: solana airdrop 2"
            exit 1
        fi
    fi
    
    # Build
    cd contract
    echo "Building contract..."
    anchor build
    
    # Deploy if requested
    if [ "$CONTRACT_ACTION" = "deploy" ]; then
        echo "Deploying contract..."
        solana program deploy \
            --program-id "../$PROGRAM_KEYPAIR" \
            target/deploy/solana_core_contracts.so
        echo "✅ Contract deployed: $PROGRAM_ID"
    else
        echo "✅ Contract built (not deployed)"
    fi
    
    cd ..
else
    echo "[ Skipping Solana Contract ]"
    
    # Still get program ID if keypair exists for display
    PROGRAM_KEYPAIR="contract/deploy/keypairs/${ENV}-program.json"
    if [ -f "$PROGRAM_KEYPAIR" ]; then
        PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
    else
        PROGRAM_ID="Not available"
    fi
fi

# === SST DEPLOYMENT ===
if aws sts get-caller-identity &>/dev/null; then
    echo ""
    echo "[ Deploying SST ]"
    cd infra
    [ -f ".env.$ENV" ] && export $(grep -v '^#' ".env.$ENV" | xargs)
    pnpm sst deploy --stage "$ENV"
    cd ..
else
    echo ""
    echo "[ Skipping SST - AWS not configured ]"
fi

# === COMPLETE ===
echo ""
echo "==================================="
echo "  ✅ Deployment Complete"
echo "==================================="
echo "Program: $PROGRAM_ID"
echo ""
echo "Start frontend: cd frontend && pnpm dev"