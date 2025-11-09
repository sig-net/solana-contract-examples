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

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

type SimpleOutputPlan = {
  script: Buffer;
  value: number;
};

type DepositPlan = {
  requester: anchor.web3.PublicKey;
  btcInputs: BtcInput[];
  btcOutputs: BtcOutput[];
  txParams: BtcDepositParams;
  requestIdBytes: number[];
  requestIdHex: string;
  creditedAmount: number;
  vaultAuthorityAddress: string;
  vaultAuthorityScript: Buffer;
  compressedVaultAuthorityPubkey: Buffer;
  globalVaultAddress: string;
  globalVaultScript: Buffer;
  compressedGlobalVaultPubkey: Buffer;
  inputUtxos: UTXO[];
  changeScript?: Buffer;
};

type WithdrawalPlan = {
  inputs: BtcInput[];
  amount: BN;
  fee: BN;
  recipientAddress: string;
  txParams: BtcWithdrawParams;
  requestIdBytes: number[];
  requestIdHex: string;
  withdrawAddress: string;
  withdrawScript: Buffer;
  globalVaultAddress: string;
  globalVaultScript: Buffer;
  compressedGlobalVaultPubkey: Buffer;
  selectedUtxos: UTXO[];
  feeBudget: number;
};

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
  globalVault: anchor.web3.PublicKey;
  compressedGlobalVaultPubkey: Buffer;
  globalVaultScript: Buffer;
  globalVaultAddress: string;
};

type VaultContext = GlobalVaultContext & {
  path: string;
  // vaultAuthority refers to the user-specific PDA derived from b"vault_authority" + requester.
  vaultAuthority: anchor.web3.PublicKey;
  compressedVaultAuthorityPubkey: Buffer;
  vaultAuthorityScript: Buffer;
  vaultAuthorityAddress: string;
};

const bnToNumber = (value: BN | number): number =>
  BN.isBN(value) ? value.toNumber() : value;

const bnToBigInt = (value: BN | number): bigint =>
  BN.isBN(value) ? BigInt(value.toString()) : BigInt(value);

const bufferFromBytes = (value: Buffer | number[] | Uint8Array): Buffer =>
  Buffer.isBuffer(value) ? value : Buffer.from(value);

const composeDepositPlan = (
  params: {
    requester: anchor.web3.PublicKey;
    btcInputs: BtcInput[];
    btcOutputs: BtcOutput[];
    txParams: BtcDepositParams;
    path: string;
    vaultAuthority: anchor.web3.PublicKey;
  },
  metadata: {
    vaultAuthorityAddress: string;
    vaultAuthorityScript: Buffer;
    compressedVaultAuthorityPubkey: Buffer;
    globalVaultAddress: string;
    globalVaultScript: Buffer;
    compressedGlobalVaultPubkey: Buffer;
    inputUtxos: UTXO[];
    changeScript?: Buffer;
  }
): DepositPlan => {
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

  const txidInternal = Buffer.from(tx.getId(), "hex").reverse();
  const requestIdHex = RequestIdGenerator.generateSignBidirectionalRequestId(
    params.vaultAuthority.toString(),
    Array.from(txidInternal),
    params.txParams.caip2Id,
    0,
    params.path,
    "ECDSA",
    "bitcoin",
    ""
  );
  const requestIdBytes = Array.from(Buffer.from(requestIdHex.slice(2), "hex"));

  const vaultScriptHex = Buffer.from(
    params.txParams.vaultScriptPubkey
  ).toString("hex");
  const creditedAmount = params.btcOutputs.reduce((acc, output) => {
    const scriptHex = Buffer.from(output.scriptPubkey).toString("hex");
    return scriptHex === vaultScriptHex ? acc + bnToNumber(output.value) : acc;
  }, 0);

  return {
    requester: params.requester,
    btcInputs: params.btcInputs,
    btcOutputs: params.btcOutputs,
    txParams: params.txParams,
    requestIdBytes,
    requestIdHex,
    creditedAmount,
    ...metadata,
  };
};

const composeWithdrawalPlan = (
  params: {
    inputs: BtcInput[];
    amount: BN;
    fee: BN;
    recipientScript: Buffer;
    recipientAddress: string;
    vaultScript: Buffer;
    caip2Id: string;
    lockTime: number;
    globalVault: anchor.web3.PublicKey;
  },
  metadata: {
    withdrawAddress: string;
    withdrawScript: Buffer;
    globalVaultAddress: string;
    globalVaultScript: Buffer;
    compressedGlobalVaultPubkey: Buffer;
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

  const amountNumber = bnToNumber(params.amount);
  const feeNumber = bnToNumber(params.fee);
  const totalInputValue = params.inputs.reduce(
    (acc, cur) => acc + bnToNumber(cur.value),
    0
  );
  const changeValue = totalInputValue - amountNumber - feeNumber;
  if (changeValue < 0) {
    throw new Error("Provided inputs do not cover amount + fee");
  }

  tx.addOutput(params.recipientScript, bnToBigInt(params.amount) as bigint);
  if (changeValue > 0) {
    tx.addOutput(params.vaultScript, BigInt(changeValue));
  }

  const txidInternal = Buffer.from(tx.getId(), "hex").reverse();
  const requestIdHex = RequestIdGenerator.generateSignBidirectionalRequestId(
    params.globalVault.toString(),
    Array.from(txidInternal),
    params.caip2Id,
    0,
    WITHDRAW_PATH,
    "ECDSA",
    "bitcoin",
    ""
  );
  const requestIdBytes = Array.from(Buffer.from(requestIdHex.slice(2), "hex"));

  const txParams: BtcWithdrawParams = {
    lockTime: params.lockTime,
    caip2Id: params.caip2Id,
    vaultScriptPubkey: params.vaultScript,
    recipientScriptPubkey: params.recipientScript,
    fee: params.fee,
  };

  return {
    inputs: params.inputs,
    amount: params.amount,
    fee: params.fee,
    recipientAddress: params.recipientAddress,
    txParams,
    requestIdBytes,
    requestIdHex,
    ...metadata,
  };
};

const buildDepositPlan = async (
  options: DepositBuildOptions
): Promise<DepositPlan> => {
  switch (options.mode) {
    case "live_single": {
      if (!program || !btcUtils || !bitcoinAdapter) {
        throw new Error("Live deposit plan requires initialized services");
      }

      const requester = options.requester ?? provider.wallet.publicKey;
      const {
        path,
        vaultAuthority,
        vaultAuthorityScript,
        vaultAuthorityAddress,
        compressedVaultAuthorityPubkey,
        globalVaultScript,
        globalVaultAddress,
        compressedGlobalVaultPubkey,
      } = deriveVaultContext(requester);

      const [utxo] = await ensureUtxos(bitcoinAdapter, vaultAuthorityAddress, {
        minCount: 1,
        minValue: LIVE_DEPOSIT_FEE + SYNTHETIC_FUNDING_BUFFER,
        context: "single deposit",
      });

      const variance = Math.floor(Math.random() * 100) + 1;
      const vaultValue = utxo.value - LIVE_DEPOSIT_FEE - variance;
      if (vaultValue <= 0) {
        throw new Error("UTXO too small to cover fees + variance");
      }

      const btcInputs: BtcInput[] = [toBtcInput(utxo, vaultAuthorityScript)];
      const btcOutputs: BtcOutput[] = [
        {
          scriptPubkey: globalVaultScript,
          value: new BN(vaultValue),
        },
      ];

      const txParams: BtcDepositParams = {
        lockTime: 0,
        caip2Id: CONFIG.BITCOIN_CAIP2_ID,
        vaultScriptPubkey: globalVaultScript,
      };

      return composeDepositPlan(
        {
          requester,
          btcInputs,
          btcOutputs,
          txParams,
          path,
          vaultAuthority,
        },
        {
          vaultAuthorityAddress,
          vaultAuthorityScript,
          compressedVaultAuthorityPubkey,
          globalVaultAddress,
          globalVaultScript,
          compressedGlobalVaultPubkey,
          inputUtxos: [utxo],
        }
      );
    }
    case "live_multi": {
      if (!program || !btcUtils || !bitcoinAdapter) {
        throw new Error("Multi-input plan requires initialized services");
      }

      const requester = options.requester;
      const {
        path,
        vaultAuthority,
        vaultAuthorityScript,
        vaultAuthorityAddress,
        compressedVaultAuthorityPubkey,
        globalVaultScript,
        globalVaultAddress,
        compressedGlobalVaultPubkey,
      } = deriveVaultContext(requester.publicKey);

      const changePath = `${path}::change`;
      const changePubkeyUncompressed =
        signetUtils.cryptography.deriveChildPublicKey(
          CONFIG.BASE_PUBLIC_KEY as `04${string}`,
          vaultAuthority.toString(),
          changePath,
          CONFIG.SOLANA_CHAIN_ID
        );
      const compressedChangePubkey = btcUtils.compressPublicKey(
        changePubkeyUncompressed
      );
      const changeScript = btcUtils.createP2WPKHScript(compressedChangePubkey);

      const inventory = await ensureUtxos(
        bitcoinAdapter,
        vaultAuthorityAddress,
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
        toBtcInput(utxo, vaultAuthorityScript)
      );

      const btcOutputs: BtcOutput[] = [
        {
          scriptPubkey: globalVaultScript,
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
        vaultScriptPubkey: globalVaultScript,
      };

      return composeDepositPlan(
        {
          requester: requester.publicKey,
          btcInputs,
          btcOutputs,
          txParams,
          path,
          vaultAuthority,
        },
        {
          vaultAuthorityAddress,
          vaultAuthorityScript,
          compressedVaultAuthorityPubkey,
          globalVaultAddress,
          globalVaultScript,
          compressedGlobalVaultPubkey,
          inputUtxos: selectedUtxos,
          changeScript,
        }
      );
    }
    case "synthetic_live": {
      if (!program || !btcUtils || !bitcoinAdapter) {
        throw new Error("Synthetic deposit requires initialized services");
      }

      const requester = options.requester ?? provider.wallet.publicKey;
      const amount = options.amount;
      const fee = options.fee ?? SYNTHETIC_TX_FEE;

      const {
        path,
        vaultAuthority,
        vaultAuthorityScript,
        vaultAuthorityAddress,
        compressedVaultAuthorityPubkey,
        globalVaultScript,
        globalVaultAddress,
        compressedGlobalVaultPubkey,
      } = deriveVaultContext(requester);

      const minInputValue = amount + fee + SYNTHETIC_FUNDING_BUFFER;
      const [utxo] = await ensureUtxos(bitcoinAdapter, vaultAuthorityAddress, {
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

      const btcInputs: BtcInput[] = [toBtcInput(utxo, vaultAuthorityScript)];
      const btcOutputs: BtcOutput[] = [
        {
          scriptPubkey: globalVaultScript,
          value: new BN(amount),
        },
      ];

      if (changeValue > 0) {
        btcOutputs.push({
          scriptPubkey: vaultAuthorityScript,
          value: new BN(changeValue),
        });
      }

      const txParams: BtcDepositParams = {
        lockTime: 0,
        caip2Id: CONFIG.BITCOIN_CAIP2_ID,
        vaultScriptPubkey: globalVaultScript,
      };

      return composeDepositPlan(
        {
          requester,
          btcInputs,
          btcOutputs,
          txParams,
          path,
          vaultAuthority,
        },
        {
          vaultAuthorityAddress,
          vaultAuthorityScript,
          compressedVaultAuthorityPubkey,
          globalVaultAddress,
          globalVaultScript,
          compressedGlobalVaultPubkey,
          inputUtxos: [utxo],
        }
      );
    }
    case "mock": {
      if (!program || !btcUtils) {
        throw new Error("Program must be initialized before building plans");
      }

      const requester = options.requester ?? provider.wallet.publicKey;
      const amount = options.amount ?? DEFAULT_DEPOSIT_AMOUNT;
      const lockTime = options.lockTime ?? 0;
      const inputValue = options.inputValue ?? amount + 500;

      const {
        path,
        vaultAuthority,
        vaultAuthorityScript,
        vaultAuthorityAddress,
        compressedVaultAuthorityPubkey,
        globalVaultScript,
        globalVaultAddress,
        compressedGlobalVaultPubkey,
      } = deriveVaultContext(requester);

      const primaryOutputScript =
        options.includeVaultOutput === false
          ? vaultAuthorityScript
          : globalVaultScript;

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
          scriptPubkey: vaultAuthorityScript,
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
        vaultScriptPubkey: globalVaultScript,
      };

      return composeDepositPlan(
        {
          requester,
          btcInputs,
          btcOutputs,
          txParams,
          path,
          vaultAuthority,
        },
        {
          vaultAuthorityAddress,
          vaultAuthorityScript,
          compressedVaultAuthorityPubkey,
          globalVaultAddress,
          globalVaultScript,
          compressedGlobalVaultPubkey,
          inputUtxos: [],
        }
      );
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

      const {
        globalVault,
        compressedGlobalVaultPubkey,
        globalVaultScript,
        globalVaultAddress,
      } = deriveGlobalVaultContext();

      const globalVaultUtxos =
        (await bitcoinAdapter.getAddressUtxos(globalVaultAddress)) ?? [];
      const targetTotal = bnToNumber(withdrawAmountBn) + feeBudget;
      const { selected: selectedUtxos, total } = selectUtxosForTarget(
        globalVaultUtxos,
        targetTotal
      );

      if (selectedUtxos.length === 0 || total < targetTotal) {
        throw new Error(
          `Unable to collect sufficient global vault liquidity for ${targetTotal} sats`
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
        toBtcInput(utxo, globalVaultScript)
      );

      return composeWithdrawalPlan(
        {
          inputs: btcInputs,
          amount: withdrawAmountBn,
          fee: new BN(feeBudget),
          recipientScript: withdrawScript,
          recipientAddress: withdrawAddress,
          vaultScript: globalVaultScript,
          caip2Id: WITHDRAW_CAIP2_ID,
          lockTime: 0,
          globalVault,
        },
        {
          withdrawAddress,
          withdrawScript,
          globalVaultAddress,
          globalVaultScript,
          compressedGlobalVaultPubkey,
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

      const {
        globalVault,
        globalVaultScript,
        globalVaultAddress,
        compressedGlobalVaultPubkey,
      } = deriveGlobalVaultContext();

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
          scriptPubkey: globalVaultScript,
          value: new BN(inputValue),
        },
      ];

      return composeWithdrawalPlan(
        {
          inputs: btcInputs,
          amount: new BN(amountValue),
          fee: new BN(feeValue),
          recipientScript: withdrawScript,
          recipientAddress: withdrawAddress,
          vaultScript: globalVaultScript,
          caip2Id: WITHDRAW_CAIP2_ID,
          lockTime: 0,
          globalVault,
        },
        {
          withdrawAddress,
          withdrawScript,
          globalVaultAddress,
          globalVaultScript,
          compressedGlobalVaultPubkey,
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
  target: number
): { selected: UTXO[]; total: number } => {
  const sorted = [...(utxos ?? [])].sort((a, b) => b.value - a.value);
  const selected: UTXO[] = [];
  let total = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.value;
    if (total >= target) {
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
    globalVault,
    compressedGlobalVaultPubkey,
    globalVaultScript,
    globalVaultAddress,
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
    vaultAuthority,
    compressedVaultAuthorityPubkey,
    vaultAuthorityScript,
    vaultAuthorityAddress,
    ...globalContext,
  };
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
      value: number;
      scriptPubkey: Buffer;
    }>,
    outputs: Array<{
      address?: string;
      script?: Buffer;
      value: number;
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
          value: BigInt(input.value),
        },
      });
    }

    // Add outputs
    for (const output of outputs) {
      if (output.address) {
        psbt.addOutput({
          address: output.address,
          value: BigInt(output.value),
        });
      } else if (output.script) {
        psbt.addOutput({
          script: Buffer.from(output.script),
          value: BigInt(output.value),
        });
      }
    }

    return psbt;
  }

  /**
   * Get PSBT hex for transmission
   */
  getPSBTHex(psbt: bitcoin.Psbt): string {
    return psbt.toHex();
  }

  /**
   * Parse PSBT from hex
   */
  parsePSBT(hex: string): bitcoin.Psbt {
    return bitcoin.Psbt.fromHex(hex);
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
    this.timeout(30000);

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
        verbose: false,
        bitcoinNetwork: CONFIG.BITCOIN_NETWORK,
      };

      server = new ChainSignatureServer(serverConfig);
      await server.start();
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

    const { requestIdBytes, requestIdHex } = preparedPlan;

    const eventPromises = await setupEventListeners(provider, requestIdHex);

    try {
      const depositTx = await program.methods
        .depositBtc(
          requestIdBytes,
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

      const [signatureEvent] = await eventPromises.waitForSignatures(1);
      if (!signatureEvent) {
        throw new Error("No MPC signature event received");
      }
      const [mpcSignature] = extractSignatures(signatureEvent);
      if (!mpcSignature) {
        throw new Error("Signature payload missing MPC signature");
      }

      const psbt = btcUtils.buildPSBT(
        preparedPlan.inputUtxos.map((utxo) => ({
          txid: utxo.txid,
          vout: utxo.vout,
          value: utxo.value,
          scriptPubkey: preparedPlan.vaultAuthorityScript,
        })),
        preparedPlan.btcOutputs.map((output) => ({
          script: output.scriptPubkey,
          value: bnToNumber(output.value),
        }))
      );

      const { witness } = prepareSignatureWitness(
        mpcSignature,
        preparedPlan.compressedVaultAuthorityPubkey
      );
      psbt.updateInput(0, { finalScriptWitness: witness });

      const signedTx = psbt.extractTransaction();
      const txHex = signedTx.toHex();
      await bitcoinAdapter.broadcastTransaction(txHex);

      if (bitcoinAdapter.mineBlocks && CONFIG.BITCOIN_NETWORK === "regtest") {
        await bitcoinAdapter.mineBlocks(1);
      }

      const readEvent = await eventPromises.readRespond;

      const claimTx = await program.methods
        .claimBtc(
          requestIdBytes,
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
    this.timeout(180000);

    const plan = await buildDepositPlan({
      mode: "live_single",
      requester: provider.wallet.publicKey,
    });
    console.log("=".repeat(60));
    console.log("Starting Bitcoin Deposit Flow Test");
    console.log("=".repeat(60) + "\n");
    console.log("Step 1: Deriving Bitcoin addresses");
    console.log(`  Deposit address: ${plan.vaultAuthorityAddress}`);
    console.log(`  Global vault address: ${plan.globalVaultAddress}\n`);

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
    const events = await setupEventListeners(provider, plan.requestIdHex);

    try {
      console.log("\n📍 STEP 3: Initiating deposit on Solana\n");
      const depositTx = await program.methods
        .depositBtc(
          plan.requestIdBytes,
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
      const [mpcSignature] = signatureEvents.flatMap(extractSignatures);

      console.log("\n📍 STEP 5: Broadcasting signed Bitcoin transaction\n");
      const psbt = btcUtils.buildPSBT(
        plan.inputUtxos.map((utxo) => ({
          txid: utxo.txid,
          vout: utxo.vout,
          value: utxo.value,
          scriptPubkey: plan.vaultAuthorityScript,
        })),
        plan.btcOutputs.map((output) => ({
          script: output.scriptPubkey,
          value: bnToNumber(output.value),
        }))
      );

      const { witness } = prepareSignatureWitness(
        mpcSignature,
        plan.compressedVaultAuthorityPubkey
      );
      psbt.updateInput(0, { finalScriptWitness: witness });

      const signedTx = psbt.extractTransaction();
      const bitcoinTxId = signedTx.getId();
      console.log(`  Bitcoin TxID: ${bitcoinTxId}`);
      await bitcoinAdapter.broadcastTransaction(signedTx.toHex());

      if (bitcoinAdapter.mineBlocks && CONFIG.BITCOIN_NETWORK === "regtest") {
        await bitcoinAdapter.mineBlocks(1);
      }

      console.log("\n📍 STEP 6: Claiming deposit on Solana\n");
      const readEvent = await events.readRespond;

      const claimTx = await program.methods
        .claimBtc(
          plan.requestIdBytes,
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
      const expectedBalance = initialBalance.add(new BN(plan.creditedAmount));
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
    console.log(`  Deposit address: ${plan.vaultAuthorityAddress}`);
    console.log(`  Global vault address: ${plan.globalVaultAddress}\n`);

    console.log("\n📍 STEP 2: Setting up event listeners for MPC signatures\n");
    const events = await setupEventListeners(provider, plan.requestIdHex);

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
          plan.requestIdBytes,
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

      plan.inputUtxos.forEach((u, idx) => {});

      console.log("\n📍 STEP 4: Waiting for MPC signatures\n");
      const signatureEvents = await events.waitForSignatures(
        plan.inputUtxos.length
      );
      const signatures = signatureEvents.flatMap(extractSignatures);
      if (signatures.length !== plan.inputUtxos.length) {
        throw new Error(
          `Expected ${plan.inputUtxos.length} signature(s), received ${signatures.length}`
        );
      }

      const psbt = btcUtils.buildPSBT(
        plan.inputUtxos.map((utxo) => ({
          txid: utxo.txid,
          vout: utxo.vout,
          value: utxo.value,
          scriptPubkey: plan.vaultAuthorityScript,
        })),
        plan.btcOutputs.map((output) => ({
          script: output.scriptPubkey,
          value: bnToNumber(output.value),
        }))
      );

      console.log("\n📍 STEP 5: Broadcasting signed Bitcoin transaction\n");
      signatures.forEach((sig, idx) => {
        const { witness } = prepareSignatureWitness(
          sig,
          plan.compressedVaultAuthorityPubkey
        );
        psbt.updateInput(idx, { finalScriptWitness: witness });
      });

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
          plan.requestIdBytes,
          Buffer.from(readEvent.serializedOutput),
          readEvent.signature,
          null
        )
        .rpc();
      await provider.connection.confirmTransaction(claimTx);

      const finalBalanceAccount = await program.account.userBtcBalance.fetch(
        userBalancePda
      );
      const expectedBalance = initialBalance.add(new BN(plan.creditedAmount));
      expect(finalBalanceAccount.amount.toString()).to.equal(
        expectedBalance.toString()
      );

      const [pendingDepositPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pending_btc_deposit"), Buffer.from(plan.requestIdBytes)],
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
    console.log(`  🏦 Global vault UTXO address: ${plan.globalVaultAddress}`);
    console.log(`  🎯 Withdrawal recipient address: ${plan.withdrawAddress}`);

    const initialRecipientUtxos =
      (await bitcoinAdapter.getAddressUtxos(plan.withdrawAddress)) ?? [];
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

    const events = await setupEventListeners(provider, plan.requestIdHex);

    console.log("\n📍 STEP 1: Initiating withdrawal on Solana\n");
    const withdrawTx = await program.methods
      .withdrawBtc(
        plan.requestIdBytes,
        plan.inputs,
        plan.amount,
        plan.recipientAddress,
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
      (acc, utxo) => acc + utxo.value,
      0
    );
    const withdrawAmount = bnToNumber(plan.amount);
    const totalDebit = bnToNumber(totalDebitBn);
    const changeValue = totalInputValue - totalDebit;

    console.log("\n📍 STEP 3: Broadcasting signed withdrawal transaction\n");
    const withdrawPsbt = btcUtils.buildPSBT(
      plan.selectedUtxos.map((utxo) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        scriptPubkey: plan.globalVaultScript,
      })),
      [
        { script: plan.withdrawScript, value: withdrawAmount },
        ...(changeValue > 0
          ? [
              {
                script: plan.globalVaultScript,
                value: changeValue,
              },
            ]
          : []),
      ]
    );

    signatures.forEach((sig, idx) => {
      const { witness } = prepareSignatureWitness(
        sig,
        plan.compressedGlobalVaultPubkey
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
        plan.requestIdBytes,
        Buffer.from(readEvent.serializedOutput),
        readEvent.signature,
        null
      )
      .rpc();
    await provider.connection.confirmTransaction(completeTx);
    console.log(`  SOL complete withdraw tx: ${completeTx}`);

    console.log("\n📍 STEP 6: Verifying post-withdrawal balance\n");
    const expectedRecipientBalance = initialRecipientBalance + withdrawAmount;
    let latestRecipientBalance = 0;
    for (let attempt = 0; attempt < 15; attempt++) {
      const utxos =
        (await bitcoinAdapter.getAddressUtxos(plan.withdrawAddress)) ?? [];
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
      [Buffer.from("pending_btc_withdrawal"), Buffer.from(plan.requestIdBytes)],
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
    const tamperedRequestId = [...plan.requestIdBytes];
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
          plan.requestIdBytes,
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
        plan.requestIdBytes,
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
      plan.requestIdBytes,
      serializedOutput
    );
    const validSignature = signHashWithMpc(messageHash);
    const invalidSignature: ChainSignaturePayload = JSON.parse(
      JSON.stringify(validSignature)
    );
    invalidSignature.s[0] ^= 0xff;

    await expectAnchorError(
      program.methods
        .claimBtc(plan.requestIdBytes, serializedOutput, invalidSignature, null)
        .rpc(),
      /Invalid signature/
    );

    const claimTx = await program.methods
      .claimBtc(plan.requestIdBytes, serializedOutput, validSignature, null)
      .rpc();
    await provider.connection.confirmTransaction(claimTx);
  });

  it("rejects claims when serialized outputs cannot be decoded", async function () {
    this.timeout(60000);
    const plan = await buildDepositPlan({ mode: "mock" });

    const depositTx = await program.methods
      .depositBtc(
        plan.requestIdBytes,
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
      computeMessageHash(plan.requestIdBytes, malformedOutput)
    );

    await expectAnchorError(
      program.methods
        .claimBtc(
          plan.requestIdBytes,
          malformedOutput,
          malformedSignature,
          null
        )
        .rpc(),
      /Invalid output format/
    );

    const successOutput = Buffer.from([1]);
    const successSig = signHashWithMpc(
      computeMessageHash(plan.requestIdBytes, successOutput)
    );
    const cleanupTx = await program.methods
      .claimBtc(plan.requestIdBytes, successOutput, successSig, null)
      .rpc();
    await provider.connection.confirmTransaction(cleanupTx);
  });

  it("refunds deposits when MPC output indicates transfer failure", async function () {
    this.timeout(60000);
    const plan = await buildDepositPlan({ mode: "mock" });

    const depositTx = await program.methods
      .depositBtc(
        plan.requestIdBytes,
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
      computeMessageHash(plan.requestIdBytes, failedOutput)
    );

    await expectAnchorError(
      program.methods
        .claimBtc(plan.requestIdBytes, failedOutput, failedSig, null)
        .rpc(),
      /Transfer failed/
    );

    const successOutput = Buffer.from([1]);
    const successSig = signHashWithMpc(
      computeMessageHash(plan.requestIdBytes, successOutput)
    );
    const cleanupTx = await program.methods
      .claimBtc(plan.requestIdBytes, successOutput, successSig, null)
      .rpc();
    await provider.connection.confirmTransaction(cleanupTx);
  });

  it("rejects withdrawals when provided inputs do not cover the requested debit", async function () {
    this.timeout(60000);
    await executeSyntheticDeposit(6_000);

    const withdrawPlan = await buildWithdrawalPlan({
      mode: "mock",
      amount: 1_500,
      fee: 25,
      inputValue: 500, // Intentionally insufficient
    });

    await expectAnchorError(
      program.methods
        .withdrawBtc(
          withdrawPlan.requestIdBytes,
          withdrawPlan.inputs,
          withdrawPlan.amount,
          withdrawPlan.recipientAddress,
          withdrawPlan.txParams
        )
        .accounts({
          authority: provider.wallet.publicKey,
          feePayer: provider.wallet.publicKey,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc(),
      /Provided inputs do not cover requested amount \+ fee/
    );
  });

  it("rejects withdrawals when user balance cannot cover amount plus fee", async function () {
    this.timeout(80000);
    await executeSyntheticDeposit(1_000);

    const withdrawPlan = await buildWithdrawalPlan({
      mode: "mock",
      amount: 900,
      fee: 200,
      inputValue: 1_300,
    });

    await expectAnchorError(
      program.methods
        .withdrawBtc(
          withdrawPlan.requestIdBytes,
          withdrawPlan.inputs,
          withdrawPlan.amount,
          withdrawPlan.recipientAddress,
          withdrawPlan.txParams
        )
        .accounts({
          authority: provider.wallet.publicKey,
          feePayer: provider.wallet.publicKey,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
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
        withdrawPlan.requestIdBytes,
        withdrawPlan.inputs,
        withdrawPlan.amount,
        withdrawPlan.recipientAddress,
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
      computeMessageHash(withdrawPlan.requestIdBytes, serializedOutput)
    );

    const completeTx = await program.methods
      .completeWithdrawBtc(
        withdrawPlan.requestIdBytes,
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
  requestId: string
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

  console.log(
    "  🔍 Subscribing to Chain Signatures events for requestId:",
    requestId
  );

  const unsubscribe = await signetContract.subscribeToEvents({
    onSignatureResponded: (event: SignatureRespondedEventPayload, slot) => {
      const eventRequestId =
        "0x" + Buffer.from(event.requestId).toString("hex");

      const isMatch = eventRequestId === requestId;
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

      const isMatch = eventRequestId === requestId;
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

      const isMatch = eventRequestId === requestId;
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
