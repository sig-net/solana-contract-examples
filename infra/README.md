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

### Switching Between Fakenet and Local Signer

The infrastructure supports two MPC signer configurations:

#### 1. Fakenet Signer (Default)
Used for testing on devnet/testnet. This is the default configuration in the `.env` file.

#### 2. Local Signer
Used for local development with a local MPC node. To switch:
1. Comment out the FAKENET configuration lines
2. Uncomment the LOCAL configuration lines
3. Redeploy the infrastructure

**Note**: As mentioned in the `.env` comments, these configurations should eventually be moved into the code rather than environment variables.

## Architecture

### Lambda Functions

The infrastructure deploys four Lambda functions:

1. **DepositWorker** (`functions/depositWorker.ts`)
   - Processes deposit transactions
   - Timeout: 180 seconds
   - Memory: 1024 MB

2. **WithdrawWorker** (`functions/withdrawWorker.ts`)
   - Processes withdrawal transactions
   - Timeout: 180 seconds
   - Memory: 1024 MB

3. **NotifyDeposit** (`functions/notifyDeposit.ts`)
   - API endpoint for deposit notifications
   - Invokes DepositWorker asynchronously
   - Timeout: 10 seconds
   - Public URL with CORS enabled

4. **NotifyWithdrawal** (`functions/notifyWithdrawal.ts`)
   - API endpoint for withdrawal notifications
   - Invokes WithdrawWorker asynchronously
   - Timeout: 10 seconds
   - Public URL with CORS enabled

### SST Configuration

The infrastructure is managed by SST v2, configured in `sst.config.ts`:

- **Stack Name**: relayer-infra
- **Runtime**: Node.js 20.x
- **Build Format**: CommonJS
- **Log Retention**: 1 week

## Deployment

### Development Environment

Deploy to development:
```bash
pnpm dev
```

This starts the SST development environment with live reloading.

### Production Deployment

Deploy to production:
```bash
pnpm deploy
# or
SST_STAGE=prod pnpm deploy
```

### Using the Deploy Script

For convenience, use the provided deploy script:
```bash
cd infra
./scripts/deploy.sh
```

The script will:
1. Load environment variables from `.env`
2. Deploy the SST stack
3. Output the Lambda function URLs

## Scripts

- `pnpm dev` - Start SST development environment
- `pnpm deploy` - Deploy to AWS
- `pnpm remove` - Remove the stack from AWS

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

## AWS Permissions

The Lambda functions require the following permissions:
- `lambda:InvokeFunction` - To invoke worker functions
- CloudWatch Logs permissions (automatically configured)

## Monitoring and Debugging

### CloudWatch Logs

All Lambda functions log to CloudWatch with 1-week retention. Access logs via:
- AWS Console → CloudWatch → Log Groups
- Filter by stack name: `/aws/lambda/prod-relayer-infra-*`

### SST Console

During development, use the SST console for real-time debugging:
```bash
pnpm dev
```

Then open the SST console URL displayed in the terminal.

## Troubleshooting

### Common Issues

1. **Deployment Fails**: 
   - Ensure AWS credentials are configured
   - Check AWS permissions for Lambda, CloudWatch, and IAM
   - Verify the AWS region matches your configuration

2. **Lambda Timeout**:
   - Worker functions have 180-second timeout
   - API functions have 10-second timeout
   - Adjust in `sst.config.ts` if needed

3. **Environment Variables Not Loading**:
   - Ensure `.env` file exists in the `infra` directory
   - Check variable names match exactly
   - Restart SST dev environment after changes

4. **CORS Errors**:
   - API lambdas are configured with `allowedOrigins: ["*"]`
   - For production, restrict to specific domains

### Debug Commands

Check stack status:
```bash
sst diff
```

View stack outputs:
```bash
aws cloudformation describe-stacks --stack-name prod-relayer-infra
```

Test Lambda function:
```bash
aws lambda invoke --function-name prod-relayer-infra-NotifyDeposit response.json
```

## Security Considerations

- Store sensitive keys in AWS Secrets Manager (not implemented yet)
- Restrict CORS origins in production
- Use IAM roles with minimum required permissions
- Regularly rotate private keys
- Monitor CloudWatch logs for suspicious activity

## Cleanup

To remove all resources:
```bash
pnpm remove
# or
SST_STAGE=prod pnpm remove
```

This will delete:
- All Lambda functions
- CloudWatch log groups
- IAM roles and policies
- API Gateway endpoints

## Support

For infrastructure issues:
- Check CloudWatch logs for error details
- Review SST documentation at https://docs.sst.dev/
- Ensure AWS service limits are not exceeded
- Verify network connectivity to RPC endpoints