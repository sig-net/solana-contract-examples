import {
  createWalletClient,
  http,
  parseEther,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { getFullEnv } from '@/lib/config/env.config';
import { getAlchemyEthSepoliaRpcUrl } from '@/lib/rpc';
import { encodeErc20Transfer, estimateFees } from '@/lib/evm/tx-builder';

const GAS_BUFFER_MULTIPLIER = 1.5;
const MAX_TOPUP_ETH = parseEther('0.01');
const GAS_LIMIT_BUFFER_PERCENT = 120n;
const ETH_TRANSFER_GAS = 21000n;

let cachedAccount: PrivateKeyAccount | null = null;

function getRelayerEthAccount(): PrivateKeyAccount {
  if (cachedAccount) return cachedAccount;

  const env = getFullEnv();
  const keypairBytes = new Uint8Array(JSON.parse(env.RELAYER_PRIVATE_KEY));
  const ethPrivateKey =
    `0x${Buffer.from(keypairBytes.slice(0, 32)).toString('hex')}` as Hex;
  cachedAccount = privateKeyToAccount(ethPrivateKey);
  return cachedAccount;
}

export function getRelayerEthAddress(): Hex {
  return getRelayerEthAccount().address;
}

async function sendGasTopUp(
  client: PublicClient,
  recipientAddress: Hex,
  deficit: bigint,
): Promise<{ txHash: Hex; amount: bigint }> {
  const topUpAmount = calculateTopUpAmount(deficit);
  const account = getRelayerEthAccount();

  const relayerBalance = await client.getBalance({ address: account.address });
  if (relayerBalance < topUpAmount) {
    throw new Error(
      `Relayer funding wallet has insufficient ETH. ` +
        `Has: ${relayerBalance}, needs: ${topUpAmount}. ` +
        `Please fund address: ${account.address}`,
    );
  }

  const [nonce, fees] = await Promise.all([
    client.getTransactionCount({ address: account.address }),
    estimateFees(client),
  ]);

  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(getAlchemyEthSepoliaRpcUrl()),
  });

  const txHash = await walletClient.sendTransaction({
    to: recipientAddress,
    value: topUpAmount,
    nonce,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    gas: ETH_TRANSFER_GAS,
  });

  await client.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
    timeout: 60_000,
  });

  return { txHash, amount: topUpAmount };
}

function calculateTopUpAmount(deficit: bigint): bigint {
  const withBuffer = BigInt(
    Math.ceil(Number(deficit) * GAS_BUFFER_MULTIPLIER),
  );
  return withBuffer > MAX_TOPUP_ETH ? MAX_TOPUP_ETH : withBuffer;
}

async function checkAndTopUp(
  client: PublicClient,
  targetAddress: Hex,
  gasLimit: bigint,
  maxFeePerGas: bigint,
): Promise<{ topUpTxHash: Hex | null; topUpAmount: bigint }> {
  const totalCost = gasLimit * maxFeePerGas;
  const balance = await client.getBalance({ address: targetAddress });

  if (balance >= totalCost) {
    return { topUpTxHash: null, topUpAmount: 0n };
  }

  const deficit = totalCost - balance;
  const { txHash, amount } = await sendGasTopUp(client, targetAddress, deficit);
  return { topUpTxHash: txHash, topUpAmount: amount };
}

export async function ensureGasForErc20Transfer(
  client: PublicClient,
  targetAddress: Hex,
  erc20Address: Hex,
  recipient: Hex,
  amount: bigint,
): Promise<{ topUpTxHash: Hex | null; topUpAmount: bigint }> {
  const data = encodeErc20Transfer(recipient, amount);

  const [estimatedGas, fees] = await Promise.all([
    client.estimateGas({
      account: targetAddress,
      to: erc20Address,
      data,
      value: 0n,
    }),
    estimateFees(client),
  ]);

  const gasLimit = (estimatedGas * GAS_LIMIT_BUFFER_PERCENT) / 100n;
  return checkAndTopUp(client, targetAddress, gasLimit, fees.maxFeePerGas);
}

export async function ensureGasForTransaction(
  client: PublicClient,
  fromAddress: Hex,
  gasLimit: bigint,
  maxFeePerGas: bigint,
): Promise<{ topUpTxHash: Hex | null; topUpAmount: bigint }> {
  return checkAndTopUp(client, fromAddress, gasLimit, maxFeePerGas);
}
