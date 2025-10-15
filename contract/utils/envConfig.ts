import { config } from "dotenv";
import { z } from "zod";
import path from "path";
import { secp256k1 } from "@noble/curves/secp256k1";

config({ path: path.resolve(__dirname, "../.env") });

const deriveBasePublicKey = (privateKey: string): string => {
  const publicKeyBytes = secp256k1.getPublicKey(privateKey.slice(2), false);
  return Buffer.from(publicKeyBytes).toString("hex");
};

const envSchema = z
  .object({
    INFURA_API_KEY: z.string().min(1, "INFURA_API_KEY is required"),
    CHAIN_SIGNATURES_PROGRAM_ID: z.string().min(32),
    MPC_ROOT_KEY: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid private key")
      .optional(),
    BASE_PUBLIC_KEY: z
      .string()
      .regex(/^04[a-fA-F0-9]{128}$/, "Invalid uncompressed public key")
      .optional(),
    SOLANA_RPC_URL: z
      .string()
      .refine(
        (val) =>
          val.startsWith("http://") ||
          val.startsWith("https://") ||
          val.startsWith("ws://") ||
          val.startsWith("wss://"),
        "Must be a valid URL"
      ),
    SOLANA_PRIVATE_KEY: z.string(),
  })
  .superRefine((data, ctx) => {
    if (!data.MPC_ROOT_KEY && !data.BASE_PUBLIC_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either MPC_ROOT_KEY or BASE_PUBLIC_KEY",
        path: ["MPC_ROOT_KEY"],
      });
    }

    if (data.MPC_ROOT_KEY && data.BASE_PUBLIC_KEY) {
      const derived = deriveBasePublicKey(data.MPC_ROOT_KEY);
      if (derived !== data.BASE_PUBLIC_KEY.toLowerCase()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "BASE_PUBLIC_KEY does not match the provided MPC_ROOT_KEY",
          path: ["BASE_PUBLIC_KEY"],
        });
      }
    }
  });

type EnvConfig = z.infer<typeof envSchema>;

const parseEnv = (): EnvConfig => {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formattedErrors = error.issues
        .map((err) => `  - ${err.path.join(".")}: ${err.message}`)
        .join("\n");
      throw new Error(
        `Environment validation failed:\n${formattedErrors}\n\nPlease check your .env file`
      );
    }
    throw error;
  }
};

export const ENV_CONFIG = parseEnv();

const resolveBasePublicKey = (env: EnvConfig): string => {
  if (env.BASE_PUBLIC_KEY) {
    return env.BASE_PUBLIC_KEY.toLowerCase();
  }

  if (!env.MPC_ROOT_KEY) {
    throw new Error("Unable to resolve BASE_PUBLIC_KEY without MPC_ROOT_KEY");
  }

  return deriveBasePublicKey(env.MPC_ROOT_KEY);
};

export const CONFIG = {
  INFURA_API_KEY: ENV_CONFIG.INFURA_API_KEY,
  BASE_PUBLIC_KEY: resolveBasePublicKey(ENV_CONFIG),
  CHAIN_SIGNATURES_PROGRAM_ID: ENV_CONFIG.CHAIN_SIGNATURES_PROGRAM_ID,
  MPC_ROOT_KEY: ENV_CONFIG.MPC_ROOT_KEY,
  USDC_ADDRESS_SEPOLIA: "0xbe72E441BF55620febc26715db68d3494213D8Cb",
  WITHDRAWAL_RECIPIENT_ADDRESS: "0xdcF0f02E13eF171aA028Bc7d4c452CFCe3C2E18f",
  SEPOLIA_CHAIN_ID: 11155111,
  ETHEREUM_CAIP2_ID: "eip155:11155111",
  EPSILON_DERIVATION_PREFIX: "sig.network v1.0.0 epsilon derivation",
  SOLANA_CHAIN_ID: "0x800001f5",
  WAIT_FOR_FUNDING_MS: 5000,
  TRANSFER_AMOUNT: "100000000",
  DECIMALS: 6,
  GAS_BUFFER_PERCENT: 20,
} as const;

export const SERVER_CONFIG = {
  SOLANA_RPC_URL: ENV_CONFIG.SOLANA_RPC_URL,
  SOLANA_PRIVATE_KEY: ENV_CONFIG.SOLANA_PRIVATE_KEY,
} as const;
