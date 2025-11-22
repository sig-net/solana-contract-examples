import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { SolanaCoreContracts } from "../target/types/solana_core_contracts.js";
import { ChainSignaturesProject } from "../types/chain_signatures_project.js";
import IDLData from "../idl/chain_signatures_project.json";

const IDL = IDLData as ChainSignaturesProject;
import { expect, AssertionError } from "chai";
import * as bitcoin from "bitcoinjs-lib";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ethers } from "ethers";
import { contracts, utils as signetUtils } from "signet.js";
import * as varuint from "varuint-bitcoin";
import { hexToBytes } from "viem";
import {
  ChainSignatureServer,
  RequestIdGenerator,
  BitcoinAdapterFactory,
  IBitcoinAdapter,
} from "fakenet-signer";
import { CONFIG, SERVER_CONFIG } from "../utils/envConfig";
import { randomBytes } from "crypto";

interface UTXO {
  txid: string;
  vout: number;
  value: number;
  status?: {
    confirmed: boolean;
    block_height?: number;
  };
}
interface BtcInput {
  txid: number[];
  vout: number;
  scriptPubkey: Buffer;
  value: BN;
}

interface BtcOutput {
  scriptPubkey: Buffer;
  value: BN;
}

interface BtcDepositParams {
  lockTime: number;
  caip2Id: string;
  vaultScriptPubkey: Buffer;
}

interface BtcWithdrawParams extends BtcDepositParams {
  recipientScriptPubkey: Buffer;
  fee: BN;
}

type AffinePoint = {
  x: number[];
  y: number[];
};

type ChainSignaturePayload = {
  bigR: AffinePoint;
  s: number[];
  recoveryId: number;
};

type ProcessedSignature = {
  r: string;
  s: string;
  v: bigint;
};

type SignatureRespondedEventPayload = {
  requestId: number[];
  responder: unknown;
  signature: ChainSignaturePayload;
};

type RespondBidirectionalEventPayload = {
  requestId: number[];
  responder: unknown;
  serializedOutput: Buffer;
  signature: ChainSignaturePayload;
};

type ChainSignatureEvents = {
  signature: Promise<SignatureRespondedEventPayload>;
  waitForSignatures: (
    count: number
  ) => Promise<SignatureRespondedEventPayload[]>;
  readRespond: Promise<RespondBidirectionalEventPayload>;
  waitForReadResponse: () => Promise<RespondBidirectionalEventPayload>;
  unsubscribe: () => Promise<void>;
  readRespondListener: number;
  program: Program<ChainSignaturesProject>;
};

let latestDepositor: anchor.web3.Keypair | null = null;

let provider: anchor.AnchorProvider;
let program: Program<SolanaCoreContracts>;
let btcUtils: BitcoinUtils;
let server: ChainSignatureServer | null = null;
let bitcoinAdapter: IBitcoinAdapter;
const DEFAULT_DEPOSIT_AMOUNT = 5_000;
const SATS_PER_BTC = 100_000_000;
const SYNTHETIC_FUNDING_BUFFER = 5_000;
const LIVE_DEPOSIT_FEE = 200;
const MULTI_INPUT_TARGET = 4;
const WITHDRAW_FEE_BUDGET = 500;
const SYNTHETIC_TX_FEE = 200;
// Keep change outputs above dust threshold to satisfy Bitcoin Core relay rules.
const MIN_WITHDRAW_CHANGE_SATS = 600;

type SimpleOutputPlan = {
  script: Buffer;
  value: number;
};

type BtcTarget = {
  pda: anchor.web3.PublicKey;
  address: string;
  script: Buffer;
  compressedPubkey: Buffer;
};

type BtcDestination = {
  address: string;
  script: Buffer;
};

type DepositPlan = {
  requester: anchor.web3.PublicKey;
  btcInputs: BtcInput[];
  btcOutputs: BtcOutput[];
  txParams: BtcDepositParams;
  path: string;
  txidExplorerHex: string;
  requestIdHex: `0x${string}`;
  creditedAmount: BN;
  vaultAuthority: BtcTarget;
  globalVault: BtcTarget;
  changeScript?: Buffer;
};

type WithdrawalPlan = {
  inputs: BtcInput[];
  amount: BN;
  fee: BN;
  recipient: BtcDestination;
  txParams: BtcWithdrawParams;
  txidExplorerHex: string;
  requestIdHex: `0x${string}`;
  globalVault: BtcTarget;
  selectedUtxos: UTXO[];
  feeBudget: number;
};

// Deposit plan flavors used across integration tests:
// - live_single: consumes one funded UTXO on regtest; requester defaults to provider wallet.
// - live_multi: builds a multi-UTXO deposit from a provided keypair requester.
// - synthetic_live: same path as live_single but lets tests choose amount/fee (funding via adapter).
// - mock: fully off-chain fabricated tx (no RPC calls) to validate on-chain checks and failures.
type DepositBuildOptions =
  | {
      mode: "live_single";
      requester?: anchor.web3.PublicKey;
    }
  | {
      mode: "live_multi";
      requester: anchor.web3.Keypair;
    }
  | {
      mode: "synthetic_live";
      requester?: anchor.web3.PublicKey;
      amount: number;
      fee?: number;
    }
  | {
      mode: "mock";
      requester?: anchor.web3.PublicKey;
      amount?: number;
      includeVaultOutput?: boolean;
      inputValue?: number;
      lockTime?: number;
      extraOutputs?: SimpleOutputPlan[];
    };

// Withdrawal plan flavors:
// - live: withdraws real UTXOs from the on-chain global vault (regtest adapter funding).
// - mock: fabricates a withdrawal PSBT for validation/error paths without Bitcoin RPC.
type WithdrawalBuildOptions =
  | {
      mode: "live";
      authority: anchor.web3.Keypair;
      feeBudget?: number;
    }
  | {
      mode: "mock";
      amount?: number;
      fee?: number;
      inputValue?: number;
    };

type GlobalVaultContext = {
  // globalVault refers to the PDA derived from the static b"global_vault_authority" seed.
  globalVault: BtcTarget;
};

type VaultContext = GlobalVaultContext & {
  path: string;
  // vaultAuthority refers to the user-specific PDA derived from b"vault_authority" + requester.
  vaultAuthority: BtcTarget;
};

const bnToBigInt = (value: BN | number | bigint): bigint =>
  BN.isBN(value) ? BigInt(value.toString()) : BigInt(value);

const bufferFromBytes = (value: Buffer | number[] | Uint8Array): Buffer =>
  Buffer.isBuffer(value) ? value : Buffer.from(value);

// Convert 0x-prefixed request id hex to byte array
const requestIdToBytes = (hexId: `0x${string}`): number[] =>
  Array.from(hexToBytes(hexId));

const planRequestIdBytes = (plan: { requestIdHex: string }): number[] =>
  requestIdToBytes(plan.requestIdHex as `0x${string}`);

const composeDepositPlan = (params: {
  requester: anchor.web3.PublicKey;
  btcInputs: BtcInput[];
  btcOutputs: BtcOutput[];
  txParams: BtcDepositParams;
  path: string;
  vaultAuthority: BtcTarget;
  globalVault: BtcTarget;
  changeScript?: Buffer;
}): DepositPlan => {
  if (!program) {
    throw new Error(
      "Program must be initialized before building deposit plans"
    );
  }

  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.locktime = params.txParams.lockTime;
  params.btcInputs.forEach((input) => {
    const txidBytes = bufferFromBytes(input.txid);
    tx.addInput(Buffer.from(txidBytes).reverse(), input.vout, 0xffffffff);
  });
  params.btcOutputs.forEach((output) => {
    tx.addOutput(
      Buffer.from(output.scriptPubkey),
      bnToBigInt(output.value) as bigint
    );
  });

  const txidExplorerHex = tx.getId();
  const txidBytes = Buffer.from(txidExplorerHex, "hex");
  // Aggregated request IDs must use explorer-order txids (no byte reversal)
  const requestIdHex = RequestIdGenerator.generateSignBidirectionalRequestId(
    params.vaultAuthority.pda.toString(),
    Array.from(txidBytes),
    params.txParams.caip2Id,
    0,
    params.path,
    "ECDSA",
    "bitcoin",
    ""
  ) as `0x${string}`;
  const vaultScriptHex = Buffer.from(
    params.txParams.vaultScriptPubkey
  ).toString("hex");
  const creditedAmount = params.btcOutputs.reduce((acc, output) => {
    const scriptHex = Buffer.from(output.scriptPubkey).toString("hex");
    return scriptHex === vaultScriptHex ? acc.add(output.value) : acc;
  }, new BN(0));

  return {
    requester: params.requester,
    btcInputs: params.btcInputs,
    btcOutputs: params.btcOutputs,
    txParams: params.txParams,
    path: params.path,
    txidExplorerHex,
    requestIdHex,
    creditedAmount,
    vaultAuthority: params.vaultAuthority,
    globalVault: params.globalVault,
    changeScript: params.changeScript,
  };
};

const composeWithdrawalPlan = (
  params: {
    inputs: BtcInput[];
    amount: BN;
    fee: BN;
    recipient: BtcDestination;
    vaultScript: Buffer;
    caip2Id: string;
    lockTime: number;
    globalVault: BtcTarget;
  },
  metadata: {
    globalVault: BtcTarget;
    selectedUtxos: UTXO[];
    feeBudget: number;
  }
): WithdrawalPlan => {
  if (!program) {
    throw new Error(
      "Program must be initialized before building withdrawal plans"
    );
  }

  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.locktime = params.lockTime;
  params.inputs.forEach((input) => {
    const txidBytes = bufferFromBytes(input.txid);
    tx.addInput(Buffer.from(txidBytes).reverse(), input.vout, 0xffffffff);
  });

  const totalInputValue = params.inputs.reduce(
    (acc, cur) => acc.add(cur.value),
    new BN(0)
  );
  const changeValue = totalInputValue.sub(params.amount).sub(params.fee);
  if (changeValue.isNeg()) {
    throw new Error("Provided inputs do not cover amount + fee");
  }

  tx.addOutput(params.recipient.script, bnToBigInt(params.amount) as bigint);
  if (changeValue.gt(new BN(0))) {
    tx.addOutput(params.vaultScript, bnToBigInt(changeValue) as bigint);
  }

  const txidExplorerHex = tx.getId();
  const txidBytes = Buffer.from(txidExplorerHex, "hex");
  // Aggregated request IDs must use explorer-order txids (no byte reversal)
  const requestIdHex = RequestIdGenerator.generateSignBidirectionalRequestId(
    params.globalVault.pda.toString(),
    Array.from(txidBytes),
    params.caip2Id,
    0,
    WITHDRAW_PATH,
    "ECDSA",
    "bitcoin",
    ""
  ) as `0x${string}`;

  const txParams: BtcWithdrawParams = {
    lockTime: params.lockTime,
    caip2Id: params.caip2Id,
    vaultScriptPubkey: params.vaultScript,
    recipientScriptPubkey: params.recipient.script,
    fee: params.fee,
  };

  return {
    inputs: params.inputs,
    amount: params.amount,
    fee: params.fee,
    recipient: params.recipient,
    txParams,
    txidExplorerHex,
    requestIdHex,
    ...metadata,
  };
};

type RequestIdComputationParams = {
  sender: string;
  txidExplorerHex: string;
  inputCount: number;
  caip2Id: string;
  path: string;
  keyVersion?: number;
  algo?: string;
  dest?: string;
  params?: string;
};

const computePerInputRequestIds = ({
  sender,
  txidExplorerHex,
  inputCount,
  caip2Id,
  path,
  keyVersion = 0,
  algo = "ECDSA",
  dest = "bitcoin",
  params = "",
}: RequestIdComputationParams): string[] => {
  const txidBytes = Buffer.from(txidExplorerHex, "hex");
  const ids: string[] = [];

  for (let i = 0; i < inputCount; i++) {
    const indexLe = Buffer.alloc(4);
    indexLe.writeUInt32LE(i, 0);
    const txData = Buffer.concat([txidBytes, indexLe]);

    const requestId = RequestIdGenerator.generateSignBidirectionalRequestId(
      sender,
      Array.from(txData),
      caip2Id,
      keyVersion,
      path,
      algo,
      dest,
      params
    );

    ids.push(requestId);
  }

  return ids;
};

function computeSignatureRequestIds(plan: DepositPlan): string[];
function computeSignatureRequestIds(plan: WithdrawalPlan): string[];
function computeSignatureRequestIds(
  plan: DepositPlan | WithdrawalPlan
): string[] {
  const isDeposit = "vaultAuthority" in plan;
  const sender = isDeposit
    ? plan.vaultAuthority.pda.toString()
    : plan.globalVault.pda.toString();
  const path = isDeposit ? plan.path : WITHDRAW_PATH;
  const inputCount = isDeposit ? plan.btcInputs.length : plan.inputs.length;

  return computePerInputRequestIds({
    sender,
    txidExplorerHex: plan.txidExplorerHex,
    inputCount,
    caip2Id: plan.txParams.caip2Id,
    path,
  });
}

const buildDepositPlan = async (
  options: DepositBuildOptions
): Promise<DepositPlan> => {
  switch (options.mode) {
    case "live_single": {
      if (!program || !btcUtils || !bitcoinAdapter) {
        throw new Error("Live deposit plan requires initialized services");
      }

      const requester = options.requester ?? provider.wallet.publicKey;
      const { path, vaultAuthority, globalVault } =
        deriveVaultContext(requester);

      const [utxo] = await ensureUtxos(bitcoinAdapter, vaultAuthority.address, {
        minCount: 1,
        minValue: LIVE_DEPOSIT_FEE + SYNTHETIC_FUNDING_BUFFER,
        context: "single deposit",
      });

      const variance = Math.floor(Math.random() * 100) + 1;
      const vaultValue = utxo.value - LIVE_DEPOSIT_FEE - variance;
      if (vaultValue <= 0) {
        throw new Error("UTXO too small to cover fees + variance");
      }

      const btcInputs: BtcInput[] = [toBtcInput(utxo, vaultAuthority.script)];
      const btcOutputs: BtcOutput[] = [
        {
          scriptPubkey: globalVault.script,
          value: new BN(vaultValue),
        },
      ];

      const txParams: BtcDepositParams = {
        lockTime: 0,
        caip2Id: CONFIG.BITCOIN_CAIP2_ID,
        vaultScriptPubkey: globalVault.script,
      };

      return composeDepositPlan({
        requester,
        btcInputs,
        btcOutputs,
        txParams,
        path,
        vaultAuthority,
        globalVault,
      });
    }
    case "live_multi": {
      if (!program || !btcUtils || !bitcoinAdapter) {
        throw new Error("Multi-input plan requires initialized services");
      }

      const requester = options.requester;
      const { path, vaultAuthority, globalVault } = deriveVaultContext(
        requester.publicKey
      );

      const changeScript = deriveChangeScript(vaultAuthority, path);

      const inventory = await ensureUtxos(
        bitcoinAdapter,
        vaultAuthority.address,
        {
          minCount: MULTI_INPUT_TARGET,
          context: "multi-input deposit",
        }
      );

      const selectedUtxos = [...inventory]
        .sort((a, b) => b.value - a.value)
        .slice(0, MULTI_INPUT_TARGET);

      const totalInputValue = selectedUtxos.reduce(
        (acc, utxo) => acc + utxo.value,
        0
      );
      const baseFee = 400;
      const randomVariation = Math.floor(Math.random() * 100) + 1;
      const changeValue = Math.floor(totalInputValue / 4);
      const vaultValue =
        totalInputValue - baseFee - randomVariation - changeValue;

      if (vaultValue <= 0) {
        throw new Error("Computed vault value is non-positive");
      }

      const btcInputs = selectedUtxos.map((utxo) =>
        toBtcInput(utxo, vaultAuthority.script)
      );

      const btcOutputs: BtcOutput[] = [
        {
          scriptPubkey: globalVault.script,
          value: new BN(vaultValue),
        },
      ];

      if (changeValue > 0) {
        btcOutputs.push({
          scriptPubkey: changeScript,
          value: new BN(changeValue),
        });
      }

      const txParams: BtcDepositParams = {
        lockTime: 0,
        caip2Id: CONFIG.BITCOIN_CAIP2_ID,
        vaultScriptPubkey: globalVault.script,
      };

      return composeDepositPlan({
        requester: requester.publicKey,
        btcInputs,
        btcOutputs,
        txParams,
        path,
        vaultAuthority,
        globalVault,
        changeScript,
      });
    }
    case "synthetic_live": {
      if (!program || !btcUtils || !bitcoinAdapter) {
        throw new Error("Synthetic deposit requires initialized services");
      }

      const requester = options.requester ?? provider.wallet.publicKey;
      const amount = options.amount;
      const fee = options.fee ?? SYNTHETIC_TX_FEE;

      const { path, vaultAuthority, globalVault } =
        deriveVaultContext(requester);

      const minInputValue = amount + fee + SYNTHETIC_FUNDING_BUFFER;
      const [utxo] = await ensureUtxos(bitcoinAdapter, vaultAuthority.address, {
        minCount: 1,
        minValue: minInputValue,
        context: `synthetic deposit (${amount} sats)`,
      });

      if (utxo.value < amount + fee) {
        throw new Error(
          `UTXO value ${utxo.value} sats cannot cover amount ${amount} + fee ${fee}`
        );
      }

      const changeValue = utxo.value - amount - fee;
      if (changeValue < 0) {
        throw new Error("Change value underflow during synthetic deposit");
      }

      const btcInputs: BtcInput[] = [toBtcInput(utxo, vaultAuthority.script)];
      const btcOutputs: BtcOutput[] = [
        {
          scriptPubkey: globalVault.script,
          value: new BN(amount),
        },
      ];

      if (changeValue > 0) {
        btcOutputs.push({
          scriptPubkey: vaultAuthority.script,
          value: new BN(changeValue),
        });
      }

      const txParams: BtcDepositParams = {
        lockTime: 0,
        caip2Id: CONFIG.BITCOIN_CAIP2_ID,
        vaultScriptPubkey: globalVault.script,
      };

      return composeDepositPlan({
        requester,
        btcInputs,
        btcOutputs,
        txParams,
        path,
        vaultAuthority,
        globalVault,
      });
    }
    case "mock": {
      if (!program || !btcUtils) {
        throw new Error("Program must be initialized before building plans");
      }

      const requester = options.requester ?? provider.wallet.publicKey;
      const amount = options.amount ?? DEFAULT_DEPOSIT_AMOUNT;
      const lockTime = options.lockTime ?? 0;
      const inputValue = options.inputValue ?? amount + 500;

      const { path, vaultAuthority, globalVault } =
        deriveVaultContext(requester);

      const primaryOutputScript =
        options.includeVaultOutput === false
          ? vaultAuthority.script
          : globalVault.script;

      const plannedOutputs: SimpleOutputPlan[] = [
        {
          script: primaryOutputScript,
          value: amount,
        },
        ...(options.extraOutputs ?? []),
      ];

      const mockTxid = randomBytes(32);
      const btcInputs: BtcInput[] = [
        {
          txid: Array.from(mockTxid),
          vout: 0,
          scriptPubkey: vaultAuthority.script,
          value: new BN(inputValue),
        },
      ];

      const btcOutputs: BtcOutput[] = plannedOutputs.map((output) => ({
        scriptPubkey: output.script,
        value: new BN(output.value),
      }));

      const txParams: BtcDepositParams = {
        lockTime,
        caip2Id: CONFIG.BITCOIN_CAIP2_ID,
        vaultScriptPubkey: globalVault.script,
      };

      return composeDepositPlan({
        requester,
        btcInputs,
        btcOutputs,
        txParams,
        path,
        vaultAuthority,
        globalVault,
      });
    }
  }
};

const buildWithdrawalPlan = async (
  options: WithdrawalBuildOptions
): Promise<WithdrawalPlan> => {
  switch (options.mode) {
    case "live": {
      if (!program || !btcUtils || !bitcoinAdapter) {
        throw new Error("Withdrawal plan requires initialized services");
      }

      const feeBudget = options.feeBudget ?? WITHDRAW_FEE_BUDGET;
      const balanceInfo = await fetchUserBalance(options.authority.publicKey);
      if (balanceInfo.amount.lte(new BN(feeBudget))) {
        throw new Error("Insufficient balance to cover withdrawal fee");
      }

      const withdrawAmountBn = balanceInfo.amount.sub(new BN(feeBudget));

      const { globalVault } = deriveGlobalVaultContext();

      const globalVaultUtxos =
        (await bitcoinAdapter.getAddressUtxos(globalVault.address)) ?? [];
      const targetTotal = withdrawAmountBn.toNumber() + feeBudget;
      const { selected: selectedUtxos, total } = selectUtxosForTarget(
        globalVaultUtxos,
        targetTotal,
        { minChange: MIN_WITHDRAW_CHANGE_SATS }
      );

      if (selectedUtxos.length === 0 || total < targetTotal) {
        throw new Error(
          `Unable to collect sufficient global vault liquidity for ${targetTotal} sats`
        );
      }

      const changeValue = total - targetTotal;
      if (changeValue > 0 && changeValue < MIN_WITHDRAW_CHANGE_SATS) {
        throw new Error(
          `Unable to construct withdrawal with non-dust change (change=${changeValue} sats). Add liquidity or increase fee budget.`
        );
      }

      const externalPrivKey = randomBytes(32);
      const externalPubkey = secp256k1.getPublicKey(externalPrivKey, false);
      const compressedExternalPubkey = btcUtils.compressPublicKey(
        Buffer.from(externalPubkey).toString("hex")
      );
      const withdrawScript = btcUtils.createP2WPKHScript(
        compressedExternalPubkey
      );
      const withdrawAddress = btcUtils.getAddressFromPubkey(
        compressedExternalPubkey
      );

      const btcInputs = selectedUtxos.map((utxo) =>
        toBtcInput(utxo, globalVault.script)
      );

      // Change is guaranteed to be zero or above the dust threshold.
      return composeWithdrawalPlan(
        {
          inputs: btcInputs,
          amount: withdrawAmountBn,
          fee: new BN(feeBudget),
          recipient: {
            script: withdrawScript,
            address: withdrawAddress,
          },
          vaultScript: globalVault.script,
          caip2Id: WITHDRAW_CAIP2_ID,
          lockTime: 0,
          globalVault,
        },
        {
          globalVault,
          selectedUtxos,
          feeBudget,
        }
      );
    }
    case "mock": {
      if (!program || !btcUtils) {
        throw new Error("Program must be initialized before building plans");
      }

      const amountValue = options.amount ?? 2_000;
      const feeValue = options.fee ?? 25;
      const inputValue = options.inputValue ?? amountValue + feeValue + 25;

      const { globalVault } = deriveGlobalVaultContext();

      const externalPrivKey = randomBytes(32);
      const externalPubkey = secp256k1.getPublicKey(externalPrivKey, false);
      const compressedExternalPubkey = btcUtils.compressPublicKey(
        Buffer.from(externalPubkey).toString("hex")
      );
      const withdrawScript = btcUtils.createP2WPKHScript(
        compressedExternalPubkey
      );
      const withdrawAddress = btcUtils.getAddressFromPubkey(
        compressedExternalPubkey
      );

      const mockTxid = randomBytes(32);
      const btcInputs: BtcInput[] = [
        {
          txid: Array.from(mockTxid),
          vout: 0,
          scriptPubkey: globalVault.script,
          value: new BN(inputValue),
        },
      ];

      return composeWithdrawalPlan(
        {
          inputs: btcInputs,
          amount: new BN(amountValue),
          fee: new BN(feeValue),
          recipient: {
            script: withdrawScript,
            address: withdrawAddress,
          },
          vaultScript: globalVault.script,
          caip2Id: WITHDRAW_CAIP2_ID,
          lockTime: 0,
          globalVault,
        },
        {
          globalVault,
          selectedUtxos: [],
          feeBudget: feeValue,
        }
      );
    }
  }
};

const SECP256K1_ORDER = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);
const SECP256K1_HALF_ORDER = BigInt(SECP256K1_ORDER) >> BigInt(1);
const WITHDRAW_CAIP2_ID = "bip122:000000000019d6689c085ae165831e93";
const WITHDRAW_PATH = "root";

function encodeVarInt(value: number): Buffer {
  const { buffer } = varuint.encode(value);
  return Buffer.from(buffer);
}

function encodeWitnessStack(items: Buffer[]): Buffer {
  const chunks: Buffer[] = [encodeVarInt(items.length)];
  for (const item of items) {
    chunks.push(encodeVarInt(item.length));
    chunks.push(item);
  }
  return Buffer.concat(chunks);
}

function prepareSignatureWitness(
  signature: ProcessedSignature,
  publicKey: Buffer
): { sigWithHashType: Buffer; witness: Buffer } {
  const rBytes = Buffer.from(signature.r.slice(2).padStart(64, "0"), "hex");
  const originalS = BigInt(signature.s);
  const lowS =
    originalS > SECP256K1_HALF_ORDER ? SECP256K1_ORDER - originalS : originalS;
  const sBytes = Buffer.from(lowS.toString(16).padStart(64, "0"), "hex");

  const rawSignature = Buffer.concat([rBytes, sBytes]);
  const sigWithHashType = Buffer.from(
    bitcoin.script.signature.encode(
      rawSignature,
      bitcoin.Transaction.SIGHASH_ALL
    )
  );
  const witness = encodeWitnessStack([sigWithHashType, publicKey]);

  return { sigWithHashType, witness };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function createFundedAuthority(
  lamports = Math.floor(0.05 * anchor.web3.LAMPORTS_PER_SOL)
): Promise<anchor.web3.Keypair> {
  const authority = anchor.web3.Keypair.generate();
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    const tx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: authority.publicKey,
        lamports,
      })
    );

    try {
      await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
      return authority;
    } catch (error: unknown) {
      lastError = error;
      const message =
        error instanceof Error ? error.message : (error as string | null);

      if (message && message.toLowerCase().includes("blockhash not found")) {
        console.warn(
          `[test] Blockhash not found when funding authority (attempt ${
            attempt + 1
          }), retrying...`
        );
        await sleep(500);
        continue;
      }

      throw error;
    }
  }

  // If we exhausted retries, surface the last error
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(String(lastError));
}

async function waitForUtxoCount(
  adapter: IBitcoinAdapter,
  address: string,
  minCount: number,
  context: string,
  maxAttempts = 15,
  delayMs = 2_000
): Promise<UTXO[]> {
  let latest: UTXO[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    latest = (await adapter.getAddressUtxos(address)) ?? [];

    if (latest.length >= minCount) {
      return latest;
    }

    await sleep(delayMs);
  }

  return latest;
}

type EnsureUtxoOptions = {
  minCount?: number;
  minValue?: number;
  context: string;
  fundingSats?: number;
};

const ensureUtxos = async (
  adapter: IBitcoinAdapter,
  address: string,
  { minCount = 1, minValue, context, fundingSats = 60_000 }: EnsureUtxoOptions
): Promise<UTXO[]> => {
  let utxos = (await adapter.getAddressUtxos(address)) ?? [];
  let attempt = 0;

  const needsFunding = () =>
    utxos.length < minCount ||
    (minValue !== undefined && !utxos.some((utxo) => utxo.value >= minValue));

  while (needsFunding() && attempt < 5) {
    if (!adapter.fundAddress) {
      break;
    }

    const satsToSend = Math.max(
      fundingSats + attempt * 10_000,
      minValue ?? 10_000,
      SYNTHETIC_FUNDING_BUFFER
    );

    await adapter.fundAddress(address, satsToSend / SATS_PER_BTC);
    if (adapter.mineBlocks && CONFIG.BITCOIN_NETWORK === "regtest") {
      await adapter.mineBlocks(1);
    }

    const currentCount = utxos.length;
    const targetCount =
      currentCount < minCount
        ? Math.min(minCount, currentCount + 1)
        : currentCount + 1;

    utxos = await waitForUtxoCount(
      adapter,
      address,
      targetCount,
      `${context} (awaiting funded UTXO)`,
      5,
      2_000
    );

    attempt += 1;
  }

  if (utxos.length < minCount) {
    throw new Error(
      `Unable to prepare ${minCount} UTXO(s) for ${address} during ${context}.`
    );
  }

  if (minValue !== undefined && !utxos.some((utxo) => utxo.value >= minValue)) {
    throw new Error(
      `Unable to find UTXO >= ${minValue} sats for ${address} during ${context}.`
    );
  }

  return utxos;
};

const toBtcInput = (utxo: UTXO, script: Buffer): BtcInput => ({
  txid: Array.from(Buffer.from(utxo.txid, "hex")),
  vout: utxo.vout,
  scriptPubkey: script,
  value: new BN(utxo.value),
});

const selectUtxosForTarget = (
  utxos: UTXO[] | null | undefined,
  target: number,
  options?: { minChange?: number }
): { selected: UTXO[]; total: number } => {
  const sorted = [...(utxos ?? [])].sort((a, b) => b.value - a.value);
  const selected: UTXO[] = [];
  let total = 0;
  const minChange = options?.minChange ?? 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.value;
    const change = total - target;

    if (total >= target && (change === 0 || change >= minChange)) {
      break;
    }
  }

  return { selected, total };
};

const deriveGlobalVaultContext = (): GlobalVaultContext => {
  if (!program || !btcUtils) {
    throw new Error("Program must be initialized before deriving vault data");
  }

  const [globalVault] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("global_vault_authority")],
    program.programId
  );

  const globalVaultPubkey = signetUtils.cryptography.deriveChildPublicKey(
    CONFIG.BASE_PUBLIC_KEY as `04${string}`,
    globalVault.toString(),
    WITHDRAW_PATH,
    CONFIG.SOLANA_CHAIN_ID
  );
  const compressedGlobalVaultPubkey =
    btcUtils.compressPublicKey(globalVaultPubkey);
  const globalVaultScript = btcUtils.createP2WPKHScript(
    compressedGlobalVaultPubkey
  );
  const globalVaultAddress = btcUtils.getAddressFromPubkey(
    compressedGlobalVaultPubkey
  );

  return {
    globalVault: {
      pda: globalVault,
      address: globalVaultAddress,
      script: globalVaultScript,
      compressedPubkey: compressedGlobalVaultPubkey,
    },
  };
};

const deriveVaultContext = (
  requester: anchor.web3.PublicKey,
  pathOverride?: string
): VaultContext => {
  if (!program || !btcUtils) {
    throw new Error("Program must be initialized before deriving vault data");
  }

  const path = pathOverride ?? requester.toString();

  const [vaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority"), requester.toBuffer()],
    program.programId
  );

  const vaultAuthorityPubkey = signetUtils.cryptography.deriveChildPublicKey(
    CONFIG.BASE_PUBLIC_KEY as `04${string}`,
    vaultAuthority.toString(),
    path,
    CONFIG.SOLANA_CHAIN_ID
  );
  const compressedVaultAuthorityPubkey =
    btcUtils.compressPublicKey(vaultAuthorityPubkey);
  const vaultAuthorityScript = btcUtils.createP2WPKHScript(
    compressedVaultAuthorityPubkey
  );
  const vaultAuthorityAddress = btcUtils.getAddressFromPubkey(
    compressedVaultAuthorityPubkey
  );

  const globalContext = deriveGlobalVaultContext();

  return {
    path,
    vaultAuthority: {
      pda: vaultAuthority,
      address: vaultAuthorityAddress,
      script: vaultAuthorityScript,
      compressedPubkey: compressedVaultAuthorityPubkey,
    },
    ...globalContext,
  };
};

const deriveChangeScript = (
  vaultAuthority: BtcTarget,
  path: string
): Buffer => {
  const changePath = `${path}::change`;
  const changePubkeyUncompressed =
    signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.BASE_PUBLIC_KEY as `04${string}`,
      vaultAuthority.pda.toString(),
      changePath,
      CONFIG.SOLANA_CHAIN_ID
    );
  const compressedChangePubkey = btcUtils.compressPublicKey(
    changePubkeyUncompressed
  );
  return btcUtils.createP2WPKHScript(compressedChangePubkey);
};

const fetchUserBalance = async (authority: anchor.web3.PublicKey) => {
  if (!program) {
    throw new Error("Program is not initialized yet");
  }

  const [userBalancePda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user_btc_balance"), authority.toBuffer()],
    program.programId
  );

  try {
    const account = await program.account.userBtcBalance.fetch(userBalancePda);
    return {
      pda: userBalancePda,
      amount: account.amount as BN,
    };
  } catch {
    return {
      pda: userBalancePda,
      amount: new BN(0),
    };
  }
};

class BitcoinUtils {
  private network: bitcoin.Network;

  constructor(networkType: "mainnet" | "testnet" | "regtest" = "testnet") {
    // Select network based on configuration
    if (networkType === "mainnet") {
      this.network = bitcoin.networks.bitcoin;
    } else if (networkType === "regtest") {
      this.network = bitcoin.networks.regtest;
    } else {
      this.network = bitcoin.networks.testnet;
    }
  }

  /**
   * Compress an uncompressed public key (65 bytes) to compressed format (33 bytes)
   * Uncompressed: 04 + x (32 bytes) + y (32 bytes)
   * Compressed: 02/03 + x (32 bytes) where prefix is 02 if y is even, 03 if y is odd
   */
  compressPublicKey(uncompressedHex: string): Buffer {
    const uncompressed = Buffer.from(uncompressedHex, "hex");

    if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
      throw new Error("Invalid uncompressed public key");
    }

    const x = uncompressed.slice(1, 33);
    const y = uncompressed.slice(33, 65);

    // Check if y is even or odd
    const prefix = y[y.length - 1] % 2 === 0 ? 0x02 : 0x03;

    return Buffer.concat([Buffer.from([prefix]), x]);
  }

  /**
   * Get Bitcoin address from public key (P2WPKH)
   */
  getAddressFromPubkey(pubkey: Buffer): string {
    const p2wpkh = bitcoin.payments.p2wpkh({
      pubkey,
      network: this.network,
    });
    return p2wpkh.address!;
  }

  /**
   * Create a P2WPKH script pubkey from a public key
   */
  createP2WPKHScript(pubkey: Buffer): Buffer {
    const p2wpkh = bitcoin.payments.p2wpkh({
      pubkey,
      network: this.network,
    });
    // Ensure it's a Node Buffer, not just Uint8Array
    return Buffer.from(p2wpkh.output!);
  }

  /**
   * Build Bitcoin PSBT transaction
   */
  buildPSBT(
    inputs: Array<{
      txid: string;
      vout: number;
      value: BN | number | bigint;
      scriptPubkey: Buffer;
    }>,
    outputs: Array<{
      address?: string;
      script?: Buffer;
      value: BN | number | bigint;
    }>
  ): bitcoin.Psbt {
    const psbt = new bitcoin.Psbt({ network: this.network });

    // Add inputs
    for (const input of inputs) {
      psbt.addInput({
        hash: input.txid,
        index: input.vout,
        witnessUtxo: {
          script: Buffer.from(input.scriptPubkey),
          value: bnToBigInt(input.value),
        },
      });
    }

    // Add outputs
    for (const output of outputs) {
      if (output.address) {
        psbt.addOutput({
          address: output.address,
          value: bnToBigInt(output.value),
        });
      } else if (output.script) {
        psbt.addOutput({
          script: Buffer.from(output.script),
          value: bnToBigInt(output.value),
        });
      }
    }

    return psbt;
  }
}

async function ensureVaultConfigInitialized(
  program: Program<SolanaCoreContracts>,
  provider: anchor.AnchorProvider
) {
  const [vaultConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault_config")],
    program.programId
  );

  const rootSignerAddress = ethers.computeAddress(
    `0x${CONFIG.BASE_PUBLIC_KEY}`
  );
  const expectedAddressBytes = Array.from(
    Buffer.from(rootSignerAddress.slice(2), "hex")
  );

  const vaultConfigAccount = await program.account.vaultConfig.fetchNullable(
    vaultConfigPda
  );

  if (!vaultConfigAccount) {
    await program.methods
      .initializeConfig(expectedAddressBytes)
      .accountsStrict({
        payer: provider.wallet.publicKey,
        config: vaultConfigPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  } else {
  }
}

describe.only("🪙 Bitcoin Deposit Integration", () => {
  before(async function () {
    this.timeout(60000);

    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    program = anchor.workspace
      .SolanaCoreContracts as Program<SolanaCoreContracts>;

    await ensureVaultConfigInitialized(program, provider);

    btcUtils = new BitcoinUtils(CONFIG.BITCOIN_NETWORK);

    bitcoinAdapter = await BitcoinAdapterFactory.create(CONFIG.BITCOIN_NETWORK);

    // Start local chain signature server for testing
    if (!SERVER_CONFIG.DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER) {
      const serverConfig = {
        solanaRpcUrl: SERVER_CONFIG.SOLANA_RPC_URL,
        solanaPrivateKey: SERVER_CONFIG.SOLANA_PRIVATE_KEY,
        mpcRootKey: CONFIG.MPC_ROOT_KEY,
        infuraApiKey: CONFIG.INFURA_API_KEY,
        programId: CONFIG.CHAIN_SIGNATURES_PROGRAM_ID,
        isDevnet: true,
        verbose: true,
        bitcoinNetwork: CONFIG.BITCOIN_NETWORK,
      };

      server = new ChainSignatureServer(serverConfig);
      await server.start();

      const subscriptionHandle = (
        server as unknown as {
          cpiSubscriptionId?: number | Promise<number> | null;
        }
      ).cpiSubscriptionId;
      if (
        subscriptionHandle &&
        typeof (subscriptionHandle as Promise<number>).then === "function"
      ) {
        try {
          const subscriptionId = await subscriptionHandle;
          (
            server as unknown as { cpiSubscriptionId?: number | null }
          ).cpiSubscriptionId = subscriptionId;
        } catch (error) {
          console.warn(
            "Chain signature log subscription failed to initialize:",
            error
          );
        }
      }

      // Give the RPC websocket a moment to start streaming logs before we submit the first request
      await new Promise((resolve) => setTimeout(resolve, 1000));

      try {
        const warmupRequester = anchor.web3.Keypair.generate();
        await executeSyntheticDeposit(500, warmupRequester.publicKey);
      } catch (error) {
        console.warn("Warmup synthetic deposit failed:", error);
      }
    }
  });

  after(async function () {
    this.timeout(10000);

    if (server) {
      await server.shutdown();
      server = null;
    }
  });

  const computeMessageHash = (
    requestIdBytes: number[],
    serializedOutput: Buffer
  ): Buffer => {
    const payload = ethers.concat([
      Uint8Array.from(requestIdBytes),
      serializedOutput,
    ]);
    return Buffer.from(ethers.keccak256(payload).slice(2), "hex");
  };

  const signHashWithMpc = (hash: Buffer): ChainSignaturePayload => {
    const signingKey = new ethers.SigningKey(CONFIG.MPC_ROOT_KEY);
    const signature = signingKey.sign(hash);
    const rBytes = Buffer.from(ethers.getBytes(signature.r));
    const sBytes = Buffer.from(ethers.getBytes(signature.s));
    const recoveryId =
      Number(signature.v) >= 27
        ? Number(signature.v) - 27
        : Number(signature.v);

    return {
      bigR: {
        x: Array.from(rBytes),
        y: Array(32).fill(0),
      },
      s: Array.from(sBytes),
      recoveryId,
    };
  };

  const executeSyntheticDeposit = async (
    amount: number,
    requester = provider.wallet.publicKey
  ) => {
    if (!program || !btcUtils || !bitcoinAdapter) {
      throw new Error("Synthetic deposit requires initialized services");
    }

    const preparedPlan = await buildDepositPlan({
      mode: "synthetic_live",
      requester,
      amount,
      fee: SYNTHETIC_TX_FEE,
    });

    const { requestIdHex } = preparedPlan;
    const signatureRequestIds = computeSignatureRequestIds(preparedPlan);

    const eventPromises = await setupEventListeners(
      provider,
      signatureRequestIds,
      requestIdHex
    );

    try {
      const depositTx = await program.methods
        .depositBtc(
          requestIdToBytes(requestIdHex),
          preparedPlan.requester,
          preparedPlan.btcInputs,
          preparedPlan.btcOutputs,
          preparedPlan.txParams
        )
        .accounts({
          payer: provider.wallet.publicKey,
          feePayer: provider.wallet.publicKey,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();
      await provider.connection.confirmTransaction(depositTx);
      const txDetails = await provider.connection.getTransaction(depositTx, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      console.log(
        "[warmup] deposit tx signature:",
        depositTx,
        "logs:",
        txDetails?.meta?.logMessages ?? []
      );
      console.log(
        "[warmup] waiting for MPC signature event for request:",
        requestIdHex
      );

      const signatureEvents = await eventPromises.waitForSignatures(
        preparedPlan.btcInputs.length
      );
      const signatureMap = buildSignatureMap(
        signatureEvents,
        computeSignatureRequestIds(preparedPlan)
      );

      const psbt = btcUtils.buildPSBT(
        preparedPlan.btcInputs.map((input) => ({
          txid: Buffer.from(input.txid).toString("hex"),
          vout: input.vout,
          value: input.value,
          scriptPubkey: preparedPlan.vaultAuthority.script,
        })),
        preparedPlan.btcOutputs.map((output) => ({
          script: output.scriptPubkey,
          value: output.value,
        }))
      );

      applySignaturesToPsbt(
        psbt,
        signatureMap,
        computeSignatureRequestIds(preparedPlan),
        preparedPlan.vaultAuthority.compressedPubkey
      );

      const signedTx = psbt.extractTransaction();
      const txHex = signedTx.toHex();
      await bitcoinAdapter.broadcastTransaction(txHex);

      if (bitcoinAdapter.mineBlocks && CONFIG.BITCOIN_NETWORK === "regtest") {
        await bitcoinAdapter.mineBlocks(1);
      }

      const readEvent = await eventPromises.readRespond;

      const claimTx = await program.methods
        .claimBtc(
          requestIdToBytes(requestIdHex),
          Buffer.from(readEvent.serializedOutput),
          readEvent.signature,
          null
        )
        .rpc();
      await provider.connection.confirmTransaction(claimTx);
    } finally {
      await cleanupEventListeners(eventPromises);
    }

    return amount;
  };

  const getErrorMessage = (error: unknown): string => {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    if (typeof error === "string") {
      return error;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  };

  const expectAnchorError = async (
    promise: Promise<unknown>,
    matcher: RegExp | string
  ) => {
    try {
      await promise;
      expect.fail(`Expected promise to reject with ${matcher}`);
    } catch (error: unknown) {
      if (error instanceof AssertionError) {
        throw error;
      }
      const message = getErrorMessage(error);
      if (matcher instanceof RegExp) {
        expect(message).to.match(matcher);
      } else {
        expect(message).to.include(matcher);
      }
    }
  };

  it("processes a single-input BTC deposit end-to-end", async function () {
    this.timeout(45000);

    const plan = await buildDepositPlan({
      mode: "live_single",
      requester: provider.wallet.publicKey,
    });
    console.log("=".repeat(60));
    console.log("Starting Bitcoin Deposit Flow Test");
    console.log("=".repeat(60) + "\n");
    console.log("Step 1: Deriving Bitcoin addresses");
    console.log(`  Deposit address: ${plan.vaultAuthority.address}`);
    console.log(`  Global vault address: ${plan.globalVault.address}\n`);

    const [userBalancePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user_btc_balance"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    let initialBalance = new BN(0);
    try {
      const balanceAccount = await program.account.userBtcBalance.fetch(
        userBalancePda
      );
      initialBalance = balanceAccount.amount;
    } catch {
      // account doesn't exist yet
    }

    console.log("\n📍 STEP 2: Setting up event listeners for MPC signatures\n");
    const signatureRequestIds = computeSignatureRequestIds(plan);
    const events = await setupEventListeners(
      provider,
      signatureRequestIds,
      plan.requestIdHex
    );

    try {
      console.log("\n📍 STEP 3: Initiating deposit on Solana\n");
      const depositTx = await program.methods
        .depositBtc(
          planRequestIdBytes(plan),
          plan.requester,
          plan.btcInputs,
          plan.btcOutputs,
          plan.txParams
        )
        .accounts({
          payer: provider.wallet.publicKey,
          feePayer: provider.wallet.publicKey,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();
      await provider.connection.confirmTransaction(depositTx);
      console.log(`  SOL deposit tx: ${depositTx}`);

      console.log("\n📍 STEP 4: Waiting for MPC signatures\n");
      const signatureEvents = await events.waitForSignatures(
        plan.btcInputs.length
      );
      const signatureMap = buildSignatureMap(
        signatureEvents,
        computeSignatureRequestIds(plan)
      );

      console.log("\n📍 STEP 5: Broadcasting signed Bitcoin transaction\n");
      const psbt = btcUtils.buildPSBT(
        plan.btcInputs.map((input) => ({
          txid: Buffer.from(input.txid).toString("hex"),
          vout: input.vout,
          value: input.value,
          scriptPubkey: plan.vaultAuthority.script,
        })),
        plan.btcOutputs.map((output) => ({
          script: output.scriptPubkey,
          value: output.value,
        }))
      );

      applySignaturesToPsbt(
        psbt,
        signatureMap,
        computeSignatureRequestIds(plan),
        plan.vaultAuthority.compressedPubkey
      );

      const signedTx = psbt.extractTransaction();
      const bitcoinTxId = signedTx.getId();
      console.log(`  Bitcoin TxID: ${bitcoinTxId}`);
      await bitcoinAdapter.broadcastTransaction(signedTx.toHex());

      if (bitcoinAdapter.mineBlocks && CONFIG.BITCOIN_NETWORK === "regtest") {
        await bitcoinAdapter.mineBlocks(1);
      }

      console.log("\n📍 STEP 6: Claiming deposit on Solana\n");
      console.log(
        `  Waiting for respondBidirectionalEvent (respondId=${plan.requestIdHex})`
      );
      const readEvent = await events.readRespond;

      const claimTx = await program.methods
        .claimBtc(
          planRequestIdBytes(plan),
          Buffer.from(readEvent.serializedOutput),
          readEvent.signature,
          null
        )
        .rpc();
      await provider.connection.confirmTransaction(claimTx);
      console.log(`  SOL claim tx: ${claimTx}`);
      console.log(`  SOL claim tx: ${claimTx}`);

      const finalBalanceAccount = await program.account.userBtcBalance.fetch(
        userBalancePda
      );
      const expectedBalance = initialBalance.add(plan.creditedAmount);
      expect(finalBalanceAccount.amount.toString()).to.equal(
        expectedBalance.toString()
      );
      console.log(
        "\n🎉 Single-input BTC deposit test completed successfully!\n"
      );
    } finally {
      await cleanupEventListeners(events);
    }
  });

  it("processes a multi-input BTC deposit and only credits vault-directed value", async function () {
    this.timeout(180000);

    const secondaryRequester = anchor.web3.Keypair.generate();
    const plan = await buildDepositPlan({
      mode: "live_multi",
      requester: secondaryRequester,
    });
    console.log("=".repeat(60));
    console.log("Starting Multi-Input Bitcoin Deposit Test");
    console.log("=".repeat(60) + "\n");
    console.log("Step 1: Deriving Bitcoin addresses");
    console.log(`  Deposit address: ${plan.vaultAuthority.address}`);
    console.log(`  Global vault address: ${plan.globalVault.address}\n`);

    console.log("\n📍 STEP 2: Setting up event listeners for MPC signatures\n");
    const signatureRequestIds = computeSignatureRequestIds(plan);
    const events = await setupEventListeners(
      provider,
      signatureRequestIds,
      plan.requestIdHex
    );

    const [userBalancePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_btc_balance"),
        secondaryRequester.publicKey.toBuffer(),
      ],
      program.programId
    );

    let initialBalance = new BN(0);
    try {
      const balanceAccount = await program.account.userBtcBalance.fetch(
        userBalancePda
      );
      initialBalance = balanceAccount.amount;
    } catch {
      // user has no prior deposits
    }

    try {
      console.log("\n📍 STEP 3: Initiating multi-input deposit on Solana\n");
      const depositTx = await program.methods
        .depositBtc(
          planRequestIdBytes(plan),
          plan.requester,
          plan.btcInputs,
          plan.btcOutputs,
          plan.txParams
        )
        .accounts({
          payer: provider.wallet.publicKey,
          feePayer: provider.wallet.publicKey,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();
      await provider.connection.confirmTransaction(depositTx);
      console.log(`  SOL deposit tx: ${depositTx}`);

      console.log("\n📍 STEP 4: Waiting for MPC signatures\n");
      const signatureEvents = await events.waitForSignatures(
        plan.btcInputs.length
      );
      const signatureMap = buildSignatureMap(
        signatureEvents,
        computeSignatureRequestIds(plan)
      );

      const psbt = btcUtils.buildPSBT(
        plan.btcInputs.map((input) => ({
          txid: Buffer.from(input.txid).toString("hex"),
          vout: input.vout,
          value: input.value,
          scriptPubkey: plan.vaultAuthority.script,
        })),
        plan.btcOutputs.map((output) => ({
          script: output.scriptPubkey,
          value: output.value,
        }))
      );

      console.log("\n📍 STEP 5: Broadcasting signed Bitcoin transaction\n");
      applySignaturesToPsbt(
        psbt,
        signatureMap,
        computeSignatureRequestIds(plan),
        plan.vaultAuthority.compressedPubkey
      );

      const signedTx = psbt.extractTransaction();
      console.log(`  Bitcoin TxID: ${signedTx.getId()}`);
      await bitcoinAdapter.broadcastTransaction(signedTx.toHex());

      if (bitcoinAdapter.mineBlocks && CONFIG.BITCOIN_NETWORK === "regtest") {
        await bitcoinAdapter.mineBlocks(1);
      }

      console.log("\n📍 STEP 6: Claiming deposit on Solana\n");
      const readEvent = await events.readRespond;

      const claimTx = await program.methods
        .claimBtc(
          planRequestIdBytes(plan),
          Buffer.from(readEvent.serializedOutput),
          readEvent.signature,
          null
        )
        .rpc();
      await provider.connection.confirmTransaction(claimTx);

      const finalBalanceAccount = await program.account.userBtcBalance.fetch(
        userBalancePda
      );
      const expectedBalance = initialBalance.add(plan.creditedAmount);
      expect(finalBalanceAccount.amount.toString()).to.equal(
        expectedBalance.toString()
      );

      const [pendingDepositPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("pending_btc_deposit"),
          Buffer.from(planRequestIdBytes(plan)),
        ],
        program.programId
      );
      const pendingDeposit =
        await program.account.pendingBtcDeposit.fetchNullable(
          pendingDepositPda
        );
      expect(pendingDeposit).to.be.null;

      latestDepositor = secondaryRequester;
      console.log(
        "\n🎉 Multi-input BTC deposit test completed successfully!\n"
      );
    } finally {
      await cleanupEventListeners(events);
    }
  });
  it("processes a BTC withdrawal end-to-end", async function () {
    this.timeout(240000);

    if (!latestDepositor) {
      throw new Error("No vault deposit context available for withdrawal test");
    }

    const depositor = latestDepositor;
    const feeBudget = 500; // TODO: compute dynamically from feerate & tx weight

    const [userBalancePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user_btc_balance"), depositor.publicKey.toBuffer()],
      program.programId
    );
    const balanceAccount = await program.account.userBtcBalance.fetch(
      userBalancePda
    );
    const startingBalance = balanceAccount.amount;

    if (startingBalance.lte(new BN(0))) {
      throw new Error("❌ No BTC balance available for withdrawal");
    }

    const plan = await buildWithdrawalPlan({
      mode: "live",
      authority: depositor,
      feeBudget,
    });
    console.log("=".repeat(80));
    console.log("Starting Bitcoin Withdrawal Flow Test");
    console.log("=".repeat(80) + "\n");
    console.log(`  🏦 Global vault UTXO address: ${plan.globalVault.address}`);
    console.log(`  🎯 Withdrawal recipient address: ${plan.recipient.address}`);

    const initialRecipientUtxos =
      (await bitcoinAdapter.getAddressUtxos(plan.recipient.address)) ?? [];
    const initialRecipientBalance = initialRecipientUtxos.reduce(
      (acc, utxo) => acc + utxo.value,
      0
    );

    const currentLamports = await provider.connection.getBalance(
      depositor.publicKey
    );
    const requiredLamports = 2 * anchor.web3.LAMPORTS_PER_SOL;
    const lamportsShortfall = requiredLamports - currentLamports;
    if (lamportsShortfall > 0) {
      const transferIx = anchor.web3.SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: depositor.publicKey,
        lamports: lamportsShortfall,
      });
      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(transferIx)
      );
    }

    const signatureRequestIds = computeSignatureRequestIds(plan);
    const events = await setupEventListeners(
      provider,
      signatureRequestIds,
      plan.requestIdHex
    );

    console.log("\n📍 STEP 1: Initiating withdrawal on Solana\n");
    const withdrawTx = await program.methods
      .withdrawBtc(
        planRequestIdBytes(plan),
        plan.inputs,
        plan.amount,
        plan.recipient.address,
        plan.txParams
      )
      .accounts({
        authority: depositor.publicKey,
        feePayer: provider.wallet.publicKey,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .signers([depositor])
      .rpc();

    await provider.connection.confirmTransaction(withdrawTx);
    console.log(`  SOL withdraw tx: ${withdrawTx}`);

    const balanceAfterInitiationAccount =
      await program.account.userBtcBalance.fetch(userBalancePda);
    const balanceAfterInitiation = balanceAfterInitiationAccount.amount as BN;
    const totalDebitBn = plan.amount.add(plan.fee);
    const expectedAfterInitiation = startingBalance.sub(totalDebitBn);
    expect(balanceAfterInitiation.toString()).to.equal(
      expectedAfterInitiation.toString()
    );

    console.log("\n📍 STEP 2: Awaiting MPC signatures for withdrawal...\n");
    const signatureEvents = await events.waitForSignatures(
      plan.selectedUtxos.length
    );
    const signatures = signatureEvents.flatMap(extractSignatures);
    if (signatures.length !== plan.selectedUtxos.length) {
      throw new Error(
        `Expected ${plan.selectedUtxos.length} signature(s), received ${signatures.length}`
      );
    }

    const totalInputValue = plan.selectedUtxos.reduce(
      (acc, utxo) => acc.add(new BN(utxo.value)),
      new BN(0)
    );
    const changeValue = totalInputValue.sub(totalDebitBn);
    if (changeValue.isNeg()) {
      throw new Error("Selected inputs no longer cover withdrawal + fee");
    }

    console.log("\n📍 STEP 3: Broadcasting signed withdrawal transaction\n");
    const withdrawPsbt = btcUtils.buildPSBT(
      plan.selectedUtxos.map((utxo) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        scriptPubkey: plan.globalVault.script,
      })),
      [
        { script: plan.recipient.script, value: plan.amount },
        ...(changeValue.gt(new BN(0))
          ? [
              {
                script: plan.globalVault.script,
                value: changeValue,
              },
            ]
          : []),
      ]
    );

    signatures.forEach((sig, idx) => {
      const { witness } = prepareSignatureWitness(
        sig,
        plan.globalVault.compressedPubkey
      );
      withdrawPsbt.updateInput(idx, {
        finalScriptWitness: witness,
      });
    });

    const signedWithdrawTx = withdrawPsbt.extractTransaction();
    const withdrawTxHex = signedWithdrawTx.toHex();
    console.log(`  📝 Withdrawal Bitcoin TxID: ${signedWithdrawTx.getId()}`);

    const submittedTxid = await bitcoinAdapter.broadcastTransaction(
      withdrawTxHex
    );
    console.log(`  📝 Submitted TxID: ${submittedTxid}`);

    if (bitcoinAdapter.mineBlocks && CONFIG.BITCOIN_NETWORK === "regtest") {
      await bitcoinAdapter.mineBlocks(1);
    }

    console.log("\n📍 STEP 4: Waiting for verification response...\n");
    const readEvent = await events.readRespond;

    console.log("\n📍 STEP 5: Completing withdrawal on Solana\n");
    const completeTx = await program.methods
      .completeWithdrawBtc(
        planRequestIdBytes(plan),
        Buffer.from(readEvent.serializedOutput),
        readEvent.signature,
        null
      )
      .rpc();
    await provider.connection.confirmTransaction(completeTx);
    console.log(`  SOL complete withdraw tx: ${completeTx}`);

    console.log("\n📍 STEP 6: Verifying post-withdrawal balance\n");
    const withdrawAmountNumber = plan.amount.toNumber();
    const expectedRecipientBalance =
      initialRecipientBalance + withdrawAmountNumber;
    let latestRecipientBalance = 0;
    for (let attempt = 0; attempt < 15; attempt++) {
      const utxos =
        (await bitcoinAdapter.getAddressUtxos(plan.recipient.address)) ?? [];
      latestRecipientBalance = utxos.reduce((acc, utxo) => acc + utxo.value, 0);
      if (latestRecipientBalance >= expectedRecipientBalance) {
        break;
      }
      await sleep(2_000);
    }
    expect(latestRecipientBalance).to.be.at.least(expectedRecipientBalance);

    const finalBalanceAccount = await program.account.userBtcBalance.fetch(
      userBalancePda
    );
    expect(finalBalanceAccount.amount.toString()).to.equal(
      balanceAfterInitiation.toString()
    );

    const [pendingWithdrawPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("pending_btc_withdrawal"),
        Buffer.from(planRequestIdBytes(plan)),
      ],
      program.programId
    );
    const pendingWithdrawal =
      await program.account.pendingBtcWithdrawal.fetchNullable(
        pendingWithdrawPda
      );
    expect(pendingWithdrawal).to.be.null;
    console.log("\n" + "=".repeat(80));
    console.log("🎉 Bitcoin Withdrawal Flow Completed Successfully!");
    console.log("=".repeat(80) + "\n");
  });
  it("rejects deposits when request ID mismatches transaction data", async function () {
    const plan = await buildDepositPlan({ mode: "mock" });
    const tamperedRequestId = [...planRequestIdBytes(plan)];
    tamperedRequestId[0] ^= 0xff;

    await expectAnchorError(
      program.methods
        .depositBtc(
          tamperedRequestId,
          plan.requester,
          plan.btcInputs,
          plan.btcOutputs,
          plan.txParams
        )
        .accounts({
          payer: provider.wallet.publicKey,
          feePayer: provider.wallet.publicKey,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc(),
      /Invalid request ID/
    );
  });

  it("rejects deposits that omit a vault-directed output", async function () {
    const plan = await buildDepositPlan({
      mode: "mock",
      includeVaultOutput: false,
    });

    await expectAnchorError(
      program.methods
        .depositBtc(
          planRequestIdBytes(plan),
          plan.requester,
          plan.btcInputs,
          plan.btcOutputs,
          plan.txParams
        )
        .accounts({
          payer: provider.wallet.publicKey,
          feePayer: provider.wallet.publicKey,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc(),
      /No vault outputs found in transaction/
    );
  });

  it("rejects claims when the signing server response carries an invalid signature", async function () {
    this.timeout(60000);
    const plan = await buildDepositPlan({ mode: "mock" });

    const depositTx = await program.methods
      .depositBtc(
        planRequestIdBytes(plan),
        plan.requester,
        plan.btcInputs,
        plan.btcOutputs,
        plan.txParams
      )
      .accounts({
        payer: provider.wallet.publicKey,
        feePayer: provider.wallet.publicKey,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();
    await provider.connection.confirmTransaction(depositTx);

    const serializedOutput = Buffer.from([1]);
    const messageHash = computeMessageHash(
      planRequestIdBytes(plan),
      serializedOutput
    );
    const validSignature = signHashWithMpc(messageHash);
    const invalidSignature: ChainSignaturePayload = JSON.parse(
      JSON.stringify(validSignature)
    );
    invalidSignature.s[0] ^= 0xff;

    await expectAnchorError(
      program.methods
        .claimBtc(
          planRequestIdBytes(plan),
          serializedOutput,
          invalidSignature,
          null
        )
        .rpc(),
      /Invalid signature/
    );

    const claimTx = await program.methods
      .claimBtc(
        planRequestIdBytes(plan),
        serializedOutput,
        validSignature,
        null
      )
      .rpc();
    await provider.connection.confirmTransaction(claimTx);
  });

  it("rejects claims when serialized outputs cannot be decoded", async function () {
    this.timeout(60000);
    const plan = await buildDepositPlan({ mode: "mock" });

    const depositTx = await program.methods
      .depositBtc(
        planRequestIdBytes(plan),
        plan.requester,
        plan.btcInputs,
        plan.btcOutputs,
        plan.txParams
      )
      .accounts({
        payer: provider.wallet.publicKey,
        feePayer: provider.wallet.publicKey,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();
    await provider.connection.confirmTransaction(depositTx);

    const malformedOutput = Buffer.from([]);
    const malformedSignature = signHashWithMpc(
      computeMessageHash(planRequestIdBytes(plan), malformedOutput)
    );

    await expectAnchorError(
      program.methods
        .claimBtc(
          planRequestIdBytes(plan),
          malformedOutput,
          malformedSignature,
          null
        )
        .rpc(),
      /Invalid output format/
    );

    const successOutput = Buffer.from([1]);
    const successSig = signHashWithMpc(
      computeMessageHash(planRequestIdBytes(plan), successOutput)
    );
    const cleanupTx = await program.methods
      .claimBtc(planRequestIdBytes(plan), successOutput, successSig, null)
      .rpc();
    await provider.connection.confirmTransaction(cleanupTx);
  });

  it("refunds deposits when MPC output indicates transfer failure", async function () {
    this.timeout(60000);
    const plan = await buildDepositPlan({ mode: "mock" });

    const depositTx = await program.methods
      .depositBtc(
        planRequestIdBytes(plan),
        plan.requester,
        plan.btcInputs,
        plan.btcOutputs,
        plan.txParams
      )
      .accounts({
        payer: provider.wallet.publicKey,
        feePayer: provider.wallet.publicKey,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();
    await provider.connection.confirmTransaction(depositTx);

    const failedOutput = Buffer.from([0]);
    const failedSig = signHashWithMpc(
      computeMessageHash(planRequestIdBytes(plan), failedOutput)
    );

    await expectAnchorError(
      program.methods
        .claimBtc(planRequestIdBytes(plan), failedOutput, failedSig, null)
        .rpc(),
      /Transfer failed/
    );

    const successOutput = Buffer.from([1]);
    const successSig = signHashWithMpc(
      computeMessageHash(planRequestIdBytes(plan), successOutput)
    );
    const cleanupTx = await program.methods
      .claimBtc(planRequestIdBytes(plan), successOutput, successSig, null)
      .rpc();
    await provider.connection.confirmTransaction(cleanupTx);
  });

  it("rejects withdrawals when provided inputs do not cover the requested debit", async function () {
    this.timeout(60000);
    const authority = await createFundedAuthority();
    await executeSyntheticDeposit(6_000, authority.publicKey);

    const withdrawPlan = await buildWithdrawalPlan({
      mode: "mock",
      amount: 1_500,
      fee: 25,
      inputValue: 2_000,
    });

    if (!withdrawPlan.inputs.length) {
      throw new Error("Mock withdrawal plan should include at least one input");
    }
    withdrawPlan.inputs = [
      {
        ...withdrawPlan.inputs[0],
        value: new BN(500),
      },
      ...withdrawPlan.inputs.slice(1),
    ];

    await expectAnchorError(
      program.methods
        .withdrawBtc(
          planRequestIdBytes(withdrawPlan),
          withdrawPlan.inputs,
          withdrawPlan.amount,
          withdrawPlan.recipient.address,
          withdrawPlan.txParams
        )
        .accounts({
          authority: authority.publicKey,
          feePayer: provider.wallet.publicKey,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .signers([authority])
        .rpc(),
      /Provided inputs do not cover requested amount \+ fee/
    );
  });

  it("rejects withdrawals when user balance cannot cover amount plus fee", async function () {
    this.timeout(80000);
    const authority = await createFundedAuthority();
    await executeSyntheticDeposit(1_000, authority.publicKey);

    const withdrawPlan = await buildWithdrawalPlan({
      mode: "mock",
      amount: 900,
      fee: 200,
      inputValue: 1_300,
    });

    await expectAnchorError(
      program.methods
        .withdrawBtc(
          planRequestIdBytes(withdrawPlan),
          withdrawPlan.inputs,
          withdrawPlan.amount,
          withdrawPlan.recipient.address,
          withdrawPlan.txParams
        )
        .accounts({
          authority: authority.publicKey,
          feePayer: provider.wallet.publicKey,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .signers([authority])
        .rpc(),
      /Insufficient balance/
    );
  });

  it("refunds withdrawal balances when MPC reports an error via serialized output", async function () {
    this.timeout(80000);
    await executeSyntheticDeposit(7_500);

    const { amount: balanceBefore } = await fetchUserBalance(
      provider.wallet.publicKey
    );

    const withdrawPlan = await buildWithdrawalPlan({
      mode: "mock",
      amount: 2_000,
      fee: 50,
      inputValue: 2_300,
    });

    const withdrawTx = await program.methods
      .withdrawBtc(
        planRequestIdBytes(withdrawPlan),
        withdrawPlan.inputs,
        withdrawPlan.amount,
        withdrawPlan.recipient.address,
        withdrawPlan.txParams
      )
      .accounts({
        authority: provider.wallet.publicKey,
        feePayer: provider.wallet.publicKey,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();
    await provider.connection.confirmTransaction(withdrawTx);

    const serializedOutput = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00]);
    const refundSignature = signHashWithMpc(
      computeMessageHash(planRequestIdBytes(withdrawPlan), serializedOutput)
    );

    const completeTx = await program.methods
      .completeWithdrawBtc(
        planRequestIdBytes(withdrawPlan),
        serializedOutput,
        refundSignature,
        null
      )
      .rpc();
    await provider.connection.confirmTransaction(completeTx);

    const { amount: balanceAfter } = await fetchUserBalance(
      provider.wallet.publicKey
    );

    expect(balanceAfter.toString()).to.equal(balanceBefore.toString());
  });
});

/**
 * Setup event listeners for chain signatures
 */
async function setupEventListeners(
  provider: anchor.AnchorProvider,
  signatureRequestIds: string[],
  aggregateRequestId: string
): Promise<ChainSignatureEvents> {
  let signatureResolve!: (value: SignatureRespondedEventPayload) => void;
  let signatureReject!: (reason?: unknown) => void;
  let readRespondResolve!: (value: RespondBidirectionalEventPayload) => void;
  let readRespondReject!: (reason?: unknown) => void;

  const signaturePromise = new Promise<SignatureRespondedEventPayload>(
    (resolve, reject) => {
      signatureResolve = resolve;
      signatureReject = reject;
    }
  );

  const readRespondPromise = new Promise<RespondBidirectionalEventPayload>(
    (resolve, reject) => {
      readRespondResolve = resolve;
      readRespondReject = reject;
    }
  );

  const matchedSignatureEvents: SignatureRespondedEventPayload[] = [];
  const signatureWaiters: {
    count: number;
    resolve: (events: SignatureRespondedEventPayload[]) => void;
    reject: (reason?: unknown) => void;
  }[] = [];
  let firstSignatureResolved = false;

  const eventsCoveringCount = (
    count: number
  ): SignatureRespondedEventPayload[] => matchedSignatureEvents.slice(0, count);

  const resolveSignatureWaiters = () => {
    for (let i = 0; i < signatureWaiters.length; ) {
      const waiter = signatureWaiters[i];
      if (matchedSignatureEvents.length >= waiter.count) {
        waiter.resolve(eventsCoveringCount(waiter.count));
        signatureWaiters.splice(i, 1);
      } else {
        i += 1;
      }
    }
  };

  const rejectSignatureWaiters = (reason?: unknown) => {
    while (signatureWaiters.length > 0) {
      const waiter = signatureWaiters.shift();
      waiter?.reject(reason);
    }
  };

  const waitForSignatures = (
    count: number
  ): Promise<SignatureRespondedEventPayload[]> => {
    const expectedCount = Math.max(0, count);
    if (expectedCount === 0) {
      return Promise.resolve([]);
    }
    if (matchedSignatureEvents.length >= expectedCount) {
      return Promise.resolve(eventsCoveringCount(expectedCount));
    }

    return new Promise((resolve, reject) => {
      signatureWaiters.push({ count: expectedCount, resolve, reject });
    });
  };

  const rootPublicKeyUncompressed = secp256k1.getPublicKey(
    CONFIG.MPC_ROOT_KEY.slice(2),
    false
  );

  const publicKeyBytes = rootPublicKeyUncompressed.slice(1);
  const base58PublicKey = anchor.utils.bytes.bs58.encode(publicKeyBytes);
  const rootPublicKeyForSignet = `secp256k1:${base58PublicKey}`;

  const signetContract = new contracts.solana.ChainSignatureContract({
    provider,
    programId: new anchor.web3.PublicKey(CONFIG.CHAIN_SIGNATURES_PROGRAM_ID),
    config: {
      rootPublicKey: rootPublicKeyForSignet as `secp256k1:${string}`,
    },
  });

  const signatureRequestIdSet = new Set(
    signatureRequestIds.map((id) => id.toLowerCase())
  );
  const aggregateRequestIdLower = aggregateRequestId.toLowerCase();

  console.log("  🔍 Subscribing to Chain Signatures events");
  console.log(
    `    ▶️ Expecting ${signatureRequestIds.length} signature request id(s)`
  );
  signatureRequestIds.forEach((id, idx) => {
    console.log(`    • sigReqId[${idx}]: ${id}`);
  });
  console.log(`    • respondId: ${aggregateRequestId}`);

  const unsubscribe = await signetContract.subscribeToEvents({
    onSignatureResponded: (event: SignatureRespondedEventPayload, slot) => {
      const eventRequestId =
        "0x" + Buffer.from(event.requestId).toString("hex");

      const isMatch = signatureRequestIdSet.has(eventRequestId.toLowerCase());
      console.log(
        "    📨 onSignatureResponded slot=%s eventId=%s match=%s",
        slot ?? "n/a",
        eventRequestId,
        isMatch
      );

      if (isMatch) {
        matchedSignatureEvents.push(event);

        if (!firstSignatureResolved) {
          firstSignatureResolved = true;
          signatureResolve(event);
        }
        resolveSignatureWaiters();
      } else {
        console.log("    ⚠️ Ignoring unrelated signature event");
      }
    },
    onSignatureError: (event, slot) => {
      const eventRequestId =
        "0x" + Buffer.from(event.requestId).toString("hex");

      const isMatch = signatureRequestIdSet.has(eventRequestId.toLowerCase());
      console.log(
        "    ❌ onSignatureError slot=%s eventId=%s match=%s error=%s",
        slot ?? "n/a",
        eventRequestId,
        isMatch,
        event.error
      );

      if (isMatch) {
        const error = new Error(event.error);
        signatureReject(error);
        rejectSignatureWaiters(error);
      } else {
        console.log("    ⚠️ Ignoring unrelated signature error event");
      }
    },
  });

  const program: Program<ChainSignaturesProject> =
    new anchor.Program<ChainSignaturesProject>(IDL, provider);

  const readRespondListener = program.addEventListener(
    "respondBidirectionalEvent",
    (event: RespondBidirectionalEventPayload, slot: number) => {
      const eventRequestId =
        "0x" + Buffer.from(event.requestId).toString("hex");

      const isMatch = eventRequestId.toLowerCase() === aggregateRequestIdLower;
      console.log(
        "    📨 respondBidirectionalEvent slot=%s eventId=%s match=%s",
        slot ?? "n/a",
        eventRequestId,
        isMatch
      );

      if (isMatch) {
        readRespondResolve(event);
      } else {
        console.log("    ⚠️ Ignoring unrelated respondBidirectional event");
      }
    }
  );

  return {
    signature: signaturePromise,
    waitForSignatures,
    readRespond: readRespondPromise,
    waitForReadResponse: () => readRespondPromise,
    unsubscribe,
    readRespondListener,
    program,
  };
}

function extractSignatures(
  event: SignatureRespondedEventPayload
): ProcessedSignature[] {
  const signature = event.signature;
  if (!signature) {
    throw new Error("Signature event did not contain any signatures");
  }

  const rBytes = signature.bigR?.x;
  const sBytes = signature.s;
  const { recoveryId } = signature;

  if (!rBytes || !sBytes || recoveryId === undefined) {
    throw new Error("Malformed signature payload in event");
  }

  const r = `0x${Buffer.from(rBytes).toString("hex")}`;
  const s = `0x${Buffer.from(sBytes).toString("hex")}`;
  const v = BigInt(recoveryId + 27);

  return [{ r, s, v }];
}

async function cleanupEventListeners(events: ChainSignatureEvents) {
  await events.unsubscribe();
  await events.program.removeEventListener(events.readRespondListener);
}

type SignatureMap = Map<string, ProcessedSignature>;

const buildSignatureMap = (
  signatureEvents: SignatureRespondedEventPayload[],
  expectedRequestIds: string[]
): SignatureMap => {
  const map: SignatureMap = new Map();
  const expectedLower = expectedRequestIds.map((id) => id.toLowerCase());
  const signatures = signatureEvents.flatMap(extractSignatures);

  if (signatures.length !== expectedLower.length) {
    throw new Error(
      `Expected ${expectedLower.length} signatures, got ${signatures.length}`
    );
  }

  for (let i = 0; i < expectedLower.length; i++) {
    map.set(expectedLower[i], signatures[i]);
  }

  return map;
};

const applySignaturesToPsbt = (
  psbt: bitcoin.Psbt,
  signatureMap: SignatureMap,
  requestIds: string[],
  signingPubkey: Buffer
) => {
  requestIds.forEach((id, idx) => {
    const sig = signatureMap.get(id.toLowerCase());
    if (!sig) {
      throw new Error(`Missing signature for requestId ${id}`);
    }
    const { witness } = prepareSignatureWitness(sig, signingPubkey);
    psbt.updateInput(idx, { finalScriptWitness: witness });
  });
};
