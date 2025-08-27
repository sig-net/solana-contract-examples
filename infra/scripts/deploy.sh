#!/usr/bin/env bash
set -euo pipefail

# Simple, repeatable deploy for the relayer Lambdas using SST (v2).
# Usage:
#   RELAYER_PRIVATE_KEY='[...]' \
#   NEXT_PUBLIC_ALCHEMY_API_KEY=... \
#   NEXT_PUBLIC_HELIUS_RPC_URL=... \
#   AWS_REGION=us-east-1 \
#   SST_STAGE=prod \
#   bash scripts/deploy.sh
#
# Or pass stage as the first arg: bash scripts/deploy.sh prod

# Always run from the infra root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Load .env from infra root if present (can override via DOTENV_PATH)
DOTENV_PATH="${DOTENV_PATH:-.env}"
if [[ -f "$DOTENV_PATH" ]]; then
  echo "Loading environment from $DOTENV_PATH"
  set -a
  # shellcheck disable=SC1090
  . "$DOTENV_PATH"
  set +a
fi

APP_NAME="relayer-infra"

# Stage resolution
SST_STAGE="${SST_STAGE:-${1:-prod}}"
export SST_STAGE

# Region resolution (env > aws configure > default)
AWS_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
if [[ -z "${AWS_REGION}" || "${AWS_REGION}" == "None" ]]; then AWS_REGION="us-east-1"; fi
export AWS_REGION

echo "Using stage: $SST_STAGE | region: $AWS_REGION"

echo "Verifying AWS credentials..."
aws sts get-caller-identity >/dev/null

# Validate required environment variables
echo "Validating environment variables..."
: "${RELAYER_PRIVATE_KEY:?RELAYER_PRIVATE_KEY is required (JSON array for keypair)}"
: "${NEXT_PUBLIC_ALCHEMY_API_KEY:?NEXT_PUBLIC_ALCHEMY_API_KEY is required}"
: "${NEXT_PUBLIC_HELIUS_RPC_URL:?NEXT_PUBLIC_HELIUS_RPC_URL is required}"

# Ensure default CDK bootstrap exists (SST v2 expects the default qualifier hnb659fds)
if ! aws ssm get-parameter --name /cdk-bootstrap/hnb659fds/version --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "Bootstrapping CDK (default qualifier hnb659fds)..."
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  npx cdk@2 bootstrap "aws://$ACCOUNT_ID/$AWS_REGION"
fi

echo "Installing dependencies..."
pnpm install --silent

echo "Deploying with SST..."
pnpm exec sst deploy --stage "$SST_STAGE"

# Attempt to fetch outputs from the CloudFormation stack
STACK_NAME="${APP_NAME}-${SST_STAGE}-RelayerStack"
DEPOSIT_URL="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='NotifyDepositUrl'].OutputValue | [0]" \
  --output text 2>/dev/null || true)"
WITHDRAW_URL="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='NotifyWithdrawalUrl'].OutputValue | [0]" \
  --output text 2>/dev/null || true)"

echo "SST deploy complete."
if [[ "$DEPOSIT_URL" != "None" && -n "$DEPOSIT_URL" ]]; then
  echo "NotifyDepositUrl: $DEPOSIT_URL"
fi
if [[ "$WITHDRAW_URL" != "None" && -n "$WITHDRAW_URL" ]]; then
  echo "NotifyWithdrawalUrl: $WITHDRAW_URL"
fi

# Write JSON file with frontend-ready env keys
OUT_JSON="relayer-urls.json"
if [[ "$DEPOSIT_URL" != "None" && -n "$DEPOSIT_URL" ]] || [[ "$WITHDRAW_URL" != "None" && -n "$WITHDRAW_URL" ]]; then
  cat > "$OUT_JSON" <<JSON
{
  "NEXT_PUBLIC_NOTIFY_DEPOSIT_URL": "${DEPOSIT_URL:-}",
  "NEXT_PUBLIC_NOTIFY_WITHDRAWAL_URL": "${WITHDRAW_URL:-}",
  "stage": "${SST_STAGE}",
  "region": "${AWS_REGION}"
}
JSON
  echo "Wrote URLs to $(pwd)/$OUT_JSON"
fi


