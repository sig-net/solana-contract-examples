// @ts-nocheck
import { StackContext, Function } from "sst/constructs";

export default {
  config(_input: unknown) {
    return {
      name: "relayer-infra",
      region: process.env.AWS_REGION || "us-east-1",
      // Use default CDK bootstrap qualifier (hnb659fds)
    };
  },
  stacks(app: any) {
    // Set sensible defaults for all functions
    app.setDefaultFunctionProps({
      runtime: "nodejs20.x",
      nodejs: {
        format: "cjs",
        esbuild: {
          tsconfig: "tsconfig.json",
        },
      },
    });

    app.stack(function RelayerStack({ stack }: StackContext) {
      // Simple env injection (works with infra/.env and deploy script)
      const commonEnv = {
        RELAYER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY ?? "",
        NEXT_PUBLIC_ALCHEMY_API_KEY:
          process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ?? "",
        NEXT_PUBLIC_HELIUS_RPC_URL:
          process.env.NEXT_PUBLIC_HELIUS_RPC_URL ?? "",
      } as const;

      // Background worker Lambdas
      const depositWorker = new Function(stack, "DepositWorker", {
        handler: "functions/depositWorker.handler",
        timeout: 180,
        memorySize: 1024,
        logRetention: "one_week",
        environment: commonEnv,
      });

      const withdrawWorker = new Function(stack, "WithdrawWorker", {
        handler: "functions/withdrawWorker.handler",
        timeout: 180,
        memorySize: 1024,
        logRetention: "one_week",
        environment: commonEnv,
      });

      const notifyDeposit = new Function(stack, "NotifyDeposit", {
        handler: "functions/notifyDeposit.handler",
        timeout: 10,
        memorySize: 1024,
        logRetention: "one_week",
        url: {
          cors: {
            allowedOrigins: ["*"],
            allowedMethods: ["POST"],
          },
        },
        environment: {
          ...commonEnv,
          DEPOSIT_WORKER_NAME: depositWorker.functionName,
        },
      });

      const notifyWithdrawal = new Function(stack, "NotifyWithdrawal", {
        handler: "functions/notifyWithdrawal.handler",
        timeout: 10,
        memorySize: 1024,
        logRetention: "one_week",
        url: {
          cors: {
            allowedOrigins: ["*"],
            allowedMethods: ["POST"],
          },
        },
        environment: {
          ...commonEnv,
          WITHDRAW_WORKER_NAME: withdrawWorker.functionName,
        },
      });

      // Allow API lambdas to invoke workers
      // Note: using broad action for simplicity; can be narrowed with a custom policy if needed.
      notifyDeposit.attachPermissions(["lambda:InvokeFunction"]);
      notifyWithdrawal.attachPermissions(["lambda:InvokeFunction"]);

      stack.addOutputs({
        NotifyDepositName: notifyDeposit.functionName,
        NotifyWithdrawalName: notifyWithdrawal.functionName,
        NotifyDepositUrl: notifyDeposit.url ?? "",
        NotifyWithdrawalUrl: notifyWithdrawal.url ?? "",
      });
    });
  },
};
