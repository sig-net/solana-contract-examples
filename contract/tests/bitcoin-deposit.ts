import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { SolanaCoreContracts } from "../target/types/solana_core_contracts.js";
import { ChainSignaturesProject } from "../types/chain_signatures_project.js";
import IDLData from "../idl/chain_signatures_project.json";

const IDL = IDLData as ChainSignaturesProject;
import { expect } from "chai";
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
import { CONFIG, SERVER_CONFIG } from "../utils/envConfig.js";
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

    console.log(
      `  ⏳ Waiting for ${minCount} UTXOs on ${address} (attempt ${
        attempt + 1
      }/${maxAttempts}) during ${context}. Currently have ${latest.length}.`
    );

    await sleep(delayMs);
  }

  return latest;
}

class BitcoinUtils {
  private network: bitcoin.Network;

  constructor(networkType: "mainnet" | "testnet" | "regtest" = "testnet") {
    // Select network based on configuration
    if (networkType === "mainnet") {
      this.network = bitcoin.networks.bitcoin;
      console.log("  🌐 Using Bitcoin MAINNET (addresses: bc1q...)");
    } else if (networkType === "regtest") {
      this.network = bitcoin.networks.regtest;
      console.log("  🌐 Using Bitcoin REGTEST (addresses: bcrt1q...)");
    } else {
      this.network = bitcoin.networks.testnet;
      console.log("  🌐 Using Bitcoin TESTNET (addresses: tb1q...)");
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
    console.log("⚙️  Initializing vault config...");
    await program.methods
      .initializeConfig(expectedAddressBytes)
      .accountsStrict({
        payer: provider.wallet.publicKey,
        config: vaultConfigPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("✅ Vault config initialized");
  } else {
    console.log("✅ Vault config already exists");
  }
}

describe.only("🪙 Bitcoin Deposit Integration", () => {
  let provider: anchor.AnchorProvider;
  let program: Program<SolanaCoreContracts>;
  let btcUtils: BitcoinUtils;
  let server: ChainSignatureServer | null = null;
  let bitcoinAdapter: IBitcoinAdapter;

  before(async function () {
    this.timeout(30000);

    console.log("\n🚀 Setting up Bitcoin test environment...");
    console.log(`Network: ${CONFIG.BITCOIN_NETWORK}\n`);

    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    program = anchor.workspace
      .SolanaCoreContracts as Program<SolanaCoreContracts>;

    await ensureVaultConfigInitialized(program, provider);

    btcUtils = new BitcoinUtils(CONFIG.BITCOIN_NETWORK);

    bitcoinAdapter = await BitcoinAdapterFactory.create(CONFIG.BITCOIN_NETWORK);

    // Start local chain signature server for testing
    if (!SERVER_CONFIG.DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER) {
      console.log("\n🔐 Starting Chain Signature Server...");
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
      console.log("✅ Chain Signature Server started");
    }

    console.log("\n" + "=".repeat(80));
  });

  after(async function () {
    this.timeout(10000);

    if (server) {
      console.log("\n🛑 Shutting down Chain Signature Server...");
      await server.shutdown();
      server = null;
      console.log("✅ Server shutdown complete");
    }
  });

  it("processes a single-input BTC deposit end-to-end", async function () {
    this.timeout(180000); // 3 minutes for full flow

    console.log("=".repeat(60));
    console.log("Starting Bitcoin Deposit Flow Test");
    console.log("=".repeat(60) + "\n");

    // STEP 1: Derive Bitcoin addresses
    console.log("Step 1: Deriving Bitcoin addresses");

    const [vaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    const [globalVaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_vault_authority")],
      program.programId
    );

    const path = provider.wallet.publicKey.toString();

    const derivedPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.BASE_PUBLIC_KEY as `04${string}`,
      vaultAuthority.toString(),
      path,
      CONFIG.SOLANA_CHAIN_ID
    );

    const compressedPubkey = btcUtils.compressPublicKey(derivedPublicKey);
    const depositAddress = btcUtils.getAddressFromPubkey(compressedPubkey);
    const depositScript = btcUtils.createP2WPKHScript(compressedPubkey);

    const globalVaultPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.BASE_PUBLIC_KEY as `04${string}`,
      globalVaultAuthority.toString(),
      "root",
      CONFIG.SOLANA_CHAIN_ID
    );
    const compressedGlobalVaultPubkey =
      btcUtils.compressPublicKey(globalVaultPublicKey);
    const globalVaultAddress = btcUtils.getAddressFromPubkey(
      compressedGlobalVaultPubkey
    );
    const globalVaultScript = btcUtils.createP2WPKHScript(
      compressedGlobalVaultPubkey
    );

    console.log(`  Deposit address: ${depositAddress}`);
    console.log(`  Global vault address: ${globalVaultAddress}\n`);

    // =====================================================
    // STEP 2: FETCH REAL UTXOS FROM BITCOIN NETWORK
    // =====================================================

    console.log(
      `\n📍 STEP 2: Fetching UTXOs from Bitcoin ${CONFIG.BITCOIN_NETWORK}\n`
    );

    // Fetch UTXOs using Bitcoin adapter
    console.log("  🌐 Fetching UTXOs using adapter...");

    let utxos = await bitcoinAdapter.getAddressUtxos(depositAddress);

    if (!utxos || utxos.length === 0) {
      // Check if we can fund the address (either through fundAddress or getClient)

      if (bitcoinAdapter.fundAddress) {
        console.log(
          "  💰 No UTXOs found. Auto-funding address via Bitcoin adapter..."
        );
        const fundingAmount = 0.001; // 0.001 BTC = 100,000 sats

        const fundTxid = await bitcoinAdapter.fundAddress(
          depositAddress,
          fundingAmount
        );

        console.log(`  📝 Funding Transaction ID: ${fundTxid}`);

        utxos = await waitForUtxoCount(
          bitcoinAdapter,
          depositAddress,
          1,
          "single deposit funding (awaiting UTXO visibility)"
        );

        console.log(`  ✅ Address funded, awaiting confirmation\n`);
      } else {
        const fundingUrl =
          CONFIG.BITCOIN_NETWORK === "testnet"
            ? "https://testnet4.anyone.eu.org/"
            : "Use a real Bitcoin wallet";

        throw new Error(
          `❌ No UTXOs found for ${depositAddress}. Please fund this address.\n${fundingUrl}`
        );
      }
    }

    if (!utxos || utxos.length === 0) {
      throw new Error(
        `❌ Unable to prepare a funding UTXO for ${depositAddress}.`
      );
    }

    console.log(`  ✅ Found ${utxos.length} UTXO(s)`);

    // Prefer the largest UTXO to mirror production behaviour
    const utxo = utxos.sort((a, b) => b.value - a.value)[0];
    const inputValue = utxo.value;
    const fee = 200; // TODO: Replace static fee with chain-derived feerate * tx vsize
    // Add small random variation (1-10 sats) to ensure unique request IDs on each test run
    const randomVariation = Math.floor(Math.random() * 100) + 1;
    const outputValue = inputValue - fee - randomVariation;

    if (inputValue < 300) {
      throw new Error(
        `❌ UTXO too small (${inputValue} sats). Please send at least 0.00001 BTC (1000 sats) to ${depositAddress}`
      );
    }

    console.log(`  💰 Selected UTXO:`);
    console.log(`    - TxID: ${utxo.txid}`);
    console.log(`    - Vout: ${utxo.vout}`);
    console.log(`    - Value: ${inputValue} sats`);
    console.log(
      `    - Output: ${outputValue} sats (${fee} sats fee + ${randomVariation} sats variation)`
    );

    const utxoTxid = utxo.txid;

    const btcInputs: BtcInput[] = [
      {
        // DON'T reverse - pass in display format (the hex string as-is)
        // The Rust bitcoin library handles the byte order internally
        txid: Array.from(Buffer.from(utxoTxid, "hex")),
        vout: utxo.vout,
        scriptPubkey: depositScript,
        value: new BN(inputValue),
      },
    ];

    const btcOutputs: BtcOutput[] = [
      {
        scriptPubkey: globalVaultScript,
        value: new BN(outputValue),
      },
    ];

    const txParams: BtcDepositParams = {
      lockTime: 0,
      caip2Id: CONFIG.BITCOIN_CAIP2_ID,
      vaultScriptPubkey: globalVaultScript,
    };

    // =====================================================
    // STEP 3: GENERATE REQUEST ID
    // =====================================================

    console.log("\n📍 STEP 3: Generating request ID from TXID\n");

    // Build Bitcoin transaction matching EXACTLY what Rust does in btc_vault.rs
    // The Rust code builds the transaction, then calls tx.txid() to get the TXID
    // We need to match this exactly!

    const unsignedTx = new bitcoin.Transaction();
    unsignedTx.version = 2; // Version::Two in Rust

    // Add input - txid must be REVERSED for Bitcoin
    unsignedTx.addInput(
      Buffer.from(utxoTxid, "hex").reverse(),
      utxo.vout,
      0xffffffff // Sequence::MAX
    );

    // Add output
    unsignedTx.addOutput(globalVaultScript, BigInt(outputValue));

    // Set locktime
    unsignedTx.locktime = 0;

    // Get TXID - bitcoinjs-lib returns it in DISPLAY format (reversed)
    const txidDisplay = unsignedTx.getId();

    // Rust tx.txid() returns bytes in INTERNAL format (reversed from display)
    // We need to reverse to match what Rust uses for request ID calculation
    const txidInternal = Buffer.from(txidDisplay, "hex").reverse();

    console.log("  📦 TXID:", txidDisplay);

    const requestId = RequestIdGenerator.generateSignBidirectionalRequestId(
      vaultAuthority.toString(),
      Array.from(txidInternal),
      txParams.caip2Id,
      0,
      path,
      "ECDSA",
      "bitcoin",
      ""
    );

    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), "hex"));

    console.log("  🔑 Request ID:", requestId);

    // =====================================================
    // STEP 4: SETUP EVENT LISTENERS
    // =====================================================

    console.log("\n📍 STEP 4: Setting up event listeners for MPC signatures\n");

    const eventPromises = await setupEventListeners(provider, requestId);

    console.log("  ✅ Listening for signature events...");

    // =====================================================
    // STEP 5: CHECK INITIAL BALANCE
    // =====================================================

    console.log("\n📍 STEP 5: Checking initial BTC balance\n");

    const [userBalance] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user_btc_balance"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    let initialBalance = new BN(0);
    try {
      const balanceAccount = await program.account.userBtcBalance.fetch(
        userBalance
      );
      initialBalance = balanceAccount.amount;
      console.log("  💰 Initial balance:", initialBalance.toString(), "sats");
    } catch {
      console.log("  💰 Initial balance: 0 sats (account doesn't exist yet)");
    }

    // =====================================================
    // STEP 6: INITIATE DEPOSIT
    // =====================================================

    console.log("\n📍 STEP 6: Initiating Bitcoin deposit on Solana\n");

    try {
      const depositTx = await program.methods
        .depositBtc(
          requestIdBytes,
          provider.wallet.publicKey,
          btcInputs,
          btcOutputs,
          txParams
        )
        .accounts({
          payer: provider.wallet.publicKey,
          feePayer: provider.wallet.publicKey,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();

      console.log("  ✅ Deposit transaction sent:", depositTx);
      console.log("  ⏳ Waiting for confirmation...");

      await provider.connection.confirmTransaction(depositTx);
      console.log("  ✅ Transaction confirmed!");
    } catch (error: unknown) {
      console.error("\n  ❌ Deposit transaction failed!");
      console.error("  📋 SOLANA PROGRAM LOGS:");
      console.error("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      const logs =
        typeof error === "object" && error !== null && "logs" in error
          ? (error as { logs?: string[] }).logs
          : undefined;
      if (logs) {
        logs.forEach((log) => console.error("    ", log));
      }
      console.error("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
      throw error;
    }

    // =====================================================
    // STEP 7: WAIT FOR MPC SIGNATURE
    // =====================================================

    console.log("\n📍 STEP 7: Waiting for MPC signature...\n");
    console.log("  ⏳ This may take 30-60 seconds...");

    const signatureEvent = await eventPromises.signature;

    console.log("  ✅ MPC signature received!");

    const [signature] = extractSignatures(signatureEvent);
    console.log("  🔐 Signature r:", signature.r.slice(0, 16) + "...");
    console.log("  🔐 Signature s:", signature.s.slice(0, 16) + "...");
    console.log("  🔐 Signature v:", signature.v.toString());

    // =====================================================
    // STEP 8: SUBMIT TO BITCOIN NETWORK
    // =====================================================

    console.log(
      "\n📍 STEP 8: Submitting signed transaction to Bitcoin network...\n"
    );

    // Build PSBT for signing
    const psbt = btcUtils.buildPSBT(
      [
        {
          txid: utxoTxid,
          vout: utxo.vout,
          value: inputValue,
          scriptPubkey: depositScript,
        },
      ],
      [
        {
          script: globalVaultScript,
          value: outputValue,
        },
      ]
    );

    const { witness } = prepareSignatureWitness(signature, compressedPubkey);

    psbt.updateInput(0, {
      finalScriptWitness: witness,
    });

    const signedTx = psbt.extractTransaction();
    const txHex = signedTx.toHex();

    console.log("  📦 Signed transaction hex:", txHex.slice(0, 64) + "...");

    // Submit to Bitcoin network
    try {
      const submittedTxid = await bitcoinAdapter.broadcastTransaction(txHex);
      console.log("  ✅ Transaction broadcast to Bitcoin network");
      console.log("  📝 Bitcoin TxID:", submittedTxid);

      // Mine a block to confirm (if mining is supported)
      if (bitcoinAdapter.mineBlocks && CONFIG.BITCOIN_NETWORK === "regtest") {
        await bitcoinAdapter.mineBlocks(1);
        console.log("  ⛏️  Mined 1 confirmation block");
      }
    } catch (error: unknown) {
      console.error(
        "  ❌ Failed to broadcast Bitcoin transaction:",
        formatError(error)
      );
      throw error;
    }

    // =====================================================
    // STEP 9: WAIT FOR READ RESPONSE
    // =====================================================

    console.log("\n📍 STEP 9: Waiting for transaction verification...\n");

    const readEvent = await eventPromises.readRespond;
    console.log("  ✅ Verification response received!");

    const success = readEvent.serializedOutput[0] === 1;
    console.log("  📊 Transaction success:", success);

    // =====================================================
    // STEP 10: CLAIM DEPOSIT
    // =====================================================

    console.log("\n📍 STEP 10: Claiming Bitcoin deposit on Solana\n");

    const claimTx = await program.methods
      .claimBtc(
        requestIdBytes,
        Buffer.from(readEvent.serializedOutput),
        readEvent.signature,
        null // No Bitcoin tx hash for testing
      )
      .rpc();

    console.log("  ✅ Claim transaction sent:", claimTx);

    await provider.connection.confirmTransaction(claimTx);
    console.log("  ✅ Claim confirmed!");

    // =====================================================
    // STEP 11: VERIFY BALANCE
    // =====================================================

    console.log("\n📍 STEP 11: Verifying final balance\n");

    const finalBalanceAccount = await program.account.userBtcBalance.fetch(
      userBalance
    );
    const finalBalance = finalBalanceAccount.amount;

    const expectedBalance = initialBalance.add(new BN(outputValue));

    console.log("  💰 Initial balance:", initialBalance.toString(), "sats");
    console.log("  ➕ Deposited amount:", outputValue, "sats");
    console.log("  💰 Expected balance:", expectedBalance.toString(), "sats");
    console.log("  💰 Actual balance:", finalBalance.toString(), "sats");

    expect(finalBalance.toString()).to.equal(expectedBalance.toString());

    console.log("\n  ✅ Balance verified successfully!");

    // Cleanup
    await cleanupEventListeners(eventPromises);

    console.log("\n" + "=".repeat(80));
    console.log("🎉 Bitcoin Deposit Flow Completed Successfully!");
    console.log("=".repeat(80) + "\n");
  });

  it("processes a multi-input BTC deposit and only credits vault-directed value", async function () {
    this.timeout(180000);

    console.log("\n" + "=".repeat(60));
    console.log("Starting Multi-UTXO Bitcoin Deposit Test");
    console.log("=".repeat(60) + "\n");

    // STEP 1: Derive Bitcoin addresses for a secondary requester
    console.log("Step 1: Deriving Bitcoin addresses");

    const secondaryRequester = anchor.web3.Keypair.generate();

    const [vaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), secondaryRequester.publicKey.toBuffer()],
      program.programId
    );

    const [globalVaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_vault_authority")],
      program.programId
    );

    const path = secondaryRequester.publicKey.toString();

    const depositPubkeyUncompressed =
      signetUtils.cryptography.deriveChildPublicKey(
        CONFIG.BASE_PUBLIC_KEY as `04${string}`,
        vaultAuthority.toString(),
        path,
        CONFIG.SOLANA_CHAIN_ID
      );
    const compressedDepositPubkey = btcUtils.compressPublicKey(
      depositPubkeyUncompressed
    );

    const depositAddress = btcUtils.getAddressFromPubkey(
      compressedDepositPubkey
    );
    const depositScript = btcUtils.createP2WPKHScript(compressedDepositPubkey);

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

    const globalVaultPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.BASE_PUBLIC_KEY as `04${string}`,
      globalVaultAuthority.toString(),
      "root",
      CONFIG.SOLANA_CHAIN_ID
    );
    const compressedGlobalVaultPubkey =
      btcUtils.compressPublicKey(globalVaultPublicKey);
    const globalVaultAddress = btcUtils.getAddressFromPubkey(
      compressedGlobalVaultPubkey
    );
    const globalVaultScript = btcUtils.createP2WPKHScript(
      compressedGlobalVaultPubkey
    );

    console.log(`  Deposit address (secondary requester): ${depositAddress}`);
    console.log(`  Global vault address: ${globalVaultAddress}\n`);

    // STEP 2: Ensure at least four UTXOs are available
    console.log(
      `\n📍 STEP 2: Ensuring at least four UTXOs are available for ${depositAddress}\n`
    );
    console.log("  🎯 Goal: 4 inputs -> 4 MPC signatures");

    const requiredUtxos = 4;
    let utxos = await bitcoinAdapter.getAddressUtxos(depositAddress);

    if (!utxos || utxos.length < requiredUtxos) {
      if (!bitcoinAdapter.fundAddress) {
        throw new Error(
          `❌ Need at least ${requiredUtxos} UTXOs but only found ${
            utxos?.length ?? 0
          }. Auto-funding not available.`
        );
      }

      const existing = utxos?.length ?? 0;
      const rounds = Math.max(0, requiredUtxos - existing);
      for (let offset = 0; offset < rounds; offset++) {
        const index = existing + offset;
        const sats = 60_000 + index * 10_000;
        const amountBtc = Number((sats / 1e8).toFixed(8));
        const fundTxid = await bitcoinAdapter.fundAddress(
          depositAddress,
          amountBtc
        );
        console.log(
          `    - Funding round ${index + 1}: ${amountBtc} BTC (txid: ${
            fundTxid ?? "unknown"
          })`
        );

        utxos = await waitForUtxoCount(
          bitcoinAdapter,
          depositAddress,
          existing + offset + 1,
          `multi-UTXO funding round ${index + 1}/4`
        );
      }
    }

    if (!utxos || utxos.length < requiredUtxos) {
      throw new Error(
        `❌ Unable to prepare ${requiredUtxos} UTXOs for ${depositAddress}. Found ${
          utxos?.length ?? 0
        }.`
      );
    }

    const selectedUtxos = [...utxos]
      .sort((a, b) => b.value - a.value)
      .slice(0, requiredUtxos);

    console.log(`  ✅ Selected ${selectedUtxos.length} UTXOs:`);
    selectedUtxos.forEach((u, idx) => {
      console.log(
        `    [${idx}] txid=${u.txid}, vout=${u.vout}, value=${u.value} sats`
      );
    });

    const totalInputValue = selectedUtxos.reduce(
      (acc, cur) => acc + cur.value,
      0
    );
    const baseFee = 400;
    const randomVariation = Math.floor(Math.random() * 100) + 1;
    const changeValue = Math.floor(totalInputValue / 4);
    const vaultValue =
      totalInputValue - baseFee - randomVariation - changeValue;

    if (vaultValue <= 0) {
      throw new Error(
        `❌ Computed vault value is non-positive (${vaultValue}). Increase funding.`
      );
    }

    console.log(`  💰 Total input value: ${totalInputValue} sats`);
    console.log(`  💸 Fee budget: ${baseFee} sats`);
    console.log(`  🎲 Random variation: ${randomVariation} sats`);
    console.log(`  🔁 Change output: ${changeValue} sats`);
    console.log(`  🏦 Global vault output: ${vaultValue} sats`);

    const btcInputs: BtcInput[] = selectedUtxos.map((u) => ({
      txid: Array.from(Buffer.from(u.txid, "hex")),
      vout: u.vout,
      scriptPubkey: depositScript,
      value: new BN(u.value),
    }));

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

    // STEP 3: Generate request ID
    console.log("\n📍 STEP 3: Generating request ID from multi-input TX\n");

    const unsignedTx = new bitcoin.Transaction();
    unsignedTx.version = 2; // Mirror TransactionBuilder::version(Version::Two)
    selectedUtxos.forEach((u) => {
      // Inputs match the program: little-endian txid, original vout, max sequence
      unsignedTx.addInput(
        Buffer.from(u.txid, "hex").reverse(),
        u.vout,
        0xffffffff
      );
    });
    unsignedTx.addOutput(globalVaultScript, BigInt(vaultValue));
    if (changeValue > 0) {
      unsignedTx.addOutput(changeScript, BigInt(changeValue));
    }
    unsignedTx.locktime = 0;

    const txidDisplay = unsignedTx.getId();
    const txidInternal = Buffer.from(txidDisplay, "hex").reverse();

    console.log("  📦 TXID:", txidDisplay);

    const requestId = RequestIdGenerator.generateSignBidirectionalRequestId(
      vaultAuthority.toString(),
      Array.from(txidInternal),
      txParams.caip2Id,
      0,
      path,
      "ECDSA",
      "bitcoin",
      ""
    );

    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), "hex"));

    console.log("  🔑 Request ID:", requestId);

    // STEP 4: Setup event listeners
    console.log("\n📍 STEP 4: Setting up event listeners\n");

    const eventPromises = await setupEventListeners(provider, requestId);

    // STEP 5: Check initial balance
    console.log("\n📍 STEP 5: Checking secondary requester BTC balance\n");

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
      console.log("  💰 Initial balance:", initialBalance.toString(), "sats");
    } catch {
      console.log("  💰 Initial balance: 0 sats (account doesn't exist yet)");
    }

    try {
      // STEP 6: Submit deposit
      console.log("\n📍 STEP 6: Submitting multi-UTXO deposit on Solana\n");

      try {
        const depositTx = await program.methods
          .depositBtc(
            requestIdBytes,
            secondaryRequester.publicKey,
            btcInputs,
            btcOutputs,
            txParams
          )
          .accounts({
            payer: provider.wallet.publicKey,
            feePayer: provider.wallet.publicKey,
            instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .rpc();

        console.log("  ✅ Deposit transaction sent:", depositTx);
        await provider.connection.confirmTransaction(depositTx);
        console.log("  ✅ Deposit confirmed!");
      } catch (error: unknown) {
        console.error("  ❌ Deposit transaction failed!");
        const logs =
          typeof error === "object" && error !== null && "logs" in error
            ? (error as { logs?: string[] }).logs
            : undefined;
        if (logs) {
          logs.forEach((log) => console.error("    ", log));
        }
        throw error;
      }

      // STEP 7: Wait for signatures
      console.log("\n📍 STEP 7: Awaiting MPC signatures...\n");
      const signatureEvents = await eventPromises.waitForSignatures(
        selectedUtxos.length
      );
      console.log(
        "  ✅ MPC signature events received:",
        signatureEvents.length
      );

      const signatures = signatureEvents.flatMap(extractSignatures);
      if (signatures.length !== selectedUtxos.length) {
        throw new Error(
          `Expected ${selectedUtxos.length} signatures (one per input), received ${signatures.length}`
        );
      }
      console.log("  🔐 Received signatures count:", signatures.length);

      // STEP 8: Submit signed transaction to Bitcoin network
      console.log(
        "\n📍 STEP 8: Submitting signed multi-UTXO transaction to Bitcoin network...\n"
      );

      const psbt = btcUtils.buildPSBT(
        selectedUtxos.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          value: u.value,
          scriptPubkey: depositScript,
        })),
        [
          {
            script: globalVaultScript,
            value: vaultValue,
          },
          ...(changeValue > 0
            ? [
                {
                  script: changeScript,
                  value: changeValue,
                },
              ]
            : []),
        ]
      );

      signatures.forEach((sig, idx) => {
        const { witness } = prepareSignatureWitness(
          sig,
          compressedDepositPubkey
        );
        console.log(`  ✅ Prepared witness for input ${idx}`);
        psbt.updateInput(idx, {
          finalScriptWitness: witness,
        });
      });

      const signedTx = psbt.extractTransaction();
      const depositTxId = signedTx.getId();
      const txHex = signedTx.toHex();

      console.log("  📦 Signed transaction hex:", txHex.slice(0, 64) + "...");

      try {
        const submittedTxid = await bitcoinAdapter.broadcastTransaction(txHex);
        console.log("  ✅ Multi-UTXO transaction broadcast to Bitcoin network");
        console.log("  📝 Bitcoin TxID:", submittedTxid);

        if (bitcoinAdapter.mineBlocks && CONFIG.BITCOIN_NETWORK === "regtest") {
          await bitcoinAdapter.mineBlocks(1);
          console.log("  ⛏️  Mined 1 confirmation block");
        }
      } catch (error: unknown) {
        console.error(
          "  ❌ Failed to broadcast Bitcoin transaction:",
          formatError(error)
        );
        throw error;
      }

      // STEP 9: Wait for verification response
      console.log("\n📍 STEP 9: Waiting for verification response...\n");
      const readEvent = await eventPromises.readRespond;
      console.log("  ✅ Verification response received!");

      const success = readEvent.serializedOutput[0] === 1;
      console.log("  📊 Transaction success:", success);

      // STEP 10: Claim deposit
      console.log("\n📍 STEP 10: Claiming BTC deposit on Solana\n");

      const claimTx = await program.methods
        .claimBtc(
          requestIdBytes,
          Buffer.from(readEvent.serializedOutput),
          readEvent.signature,
          null
        )
        .rpc();

      console.log("  ✅ Claim transaction sent:", claimTx);
      await provider.connection.confirmTransaction(claimTx);
      console.log("  ✅ Claim confirmed!");

      // STEP 11: Verify balance reflects only vault-directed amount
      console.log("\n📍 STEP 11: Verifying post-claim BTC balance\n");

      const finalBalanceAccount = await program.account.userBtcBalance.fetch(
        userBalancePda
      );
      const finalBalance = finalBalanceAccount.amount as BN;

      const expectedBalance = initialBalance.add(new BN(vaultValue));

      console.log("  💰 Initial balance:", initialBalance.toString(), "sats");
      console.log("  ➕ Vault-directed amount:", vaultValue, "sats");
      console.log("  💰 Expected balance:", expectedBalance.toString(), "sats");
      console.log("  💰 Actual balance:", finalBalance.toString(), "sats");

      expect(finalBalance.toString()).to.equal(expectedBalance.toString());

      // STEP 12: Validate contract state
      console.log("\n📍 STEP 12: Validating contract state\n");

      const [pendingDepositPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pending_btc_deposit"), Buffer.from(requestIdBytes)],
        program.programId
      );

      const pendingDeposit =
        await program.account.pendingBtcDeposit.fetchNullable(
          pendingDepositPda
        );
      expect(pendingDeposit).to.be.null;
      console.log("  ✅ Pending deposit account closed after claim");

      latestDepositor = secondaryRequester;
    } finally {
      await cleanupEventListeners(eventPromises);
    }

    console.log("\n" + "=".repeat(80));
    console.log("🎉 Multi-UTXO Deposit Flow Completed Successfully!");
    console.log("=".repeat(80) + "\n");
  });

  it("processes a BTC withdrawal end-to-end", async function () {
    this.timeout(240000);

    if (!latestDepositor) {
      throw new Error("No vault deposit context available for withdrawal test");
    }

    const depositor = latestDepositor;

    console.log("\n" + "=".repeat(60));
    console.log("Starting Bitcoin Withdrawal Flow Test");
    console.log("=".repeat(60) + "\n");

    const [globalVaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_vault_authority")],
      program.programId
    );

    const globalVaultPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.BASE_PUBLIC_KEY as `04${string}`,
      globalVaultAuthority.toString(),
      "root",
      CONFIG.SOLANA_CHAIN_ID
    );
    const compressedGlobalVaultPubkey =
      btcUtils.compressPublicKey(globalVaultPublicKey);
    const globalVaultScript = btcUtils.createP2WPKHScript(
      compressedGlobalVaultPubkey
    );
    const globalVaultAddress = btcUtils.getAddressFromPubkey(
      compressedGlobalVaultPubkey
    );

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

    const feeBudget = 500; // TODO: compute dynamically from current feerate and tx weight
    const feeBn = new BN(feeBudget);

    if (startingBalance.lte(feeBn)) {
      throw new Error(
        "❌ User balance does not cover the withdrawal fee budget"
      );
    }

    const withdrawAmountBn = startingBalance.sub(feeBn);
    const withdrawAmount = withdrawAmountBn.toNumber();
    const totalDebit = withdrawAmount + feeBudget;

    console.log(`  💰 User BTC balance: ${startingBalance.toString()} sats`);
    console.log(`  🧾 Fee budget: ${feeBudget} sats`);
    console.log(`  💸 Planned withdrawal amount: ${withdrawAmount} sats`);

    const externalWithdrawKey = randomBytes(32);
    const externalPubkeyUncompressed = secp256k1.getPublicKey(
      externalWithdrawKey,
      false
    );
    const compressedExternalPubkey = btcUtils.compressPublicKey(
      Buffer.from(externalPubkeyUncompressed).toString("hex")
    );
    const withdrawScript = btcUtils.createP2WPKHScript(
      compressedExternalPubkey
    );
    const withdrawAddress = btcUtils.getAddressFromPubkey(
      compressedExternalPubkey
    );

    console.log(`  🏦 Global vault UTXO address: ${globalVaultAddress}`);
    console.log(`  🎯 Withdrawal recipient address: ${withdrawAddress}`);

    const initialRecipientUtxos =
      (await bitcoinAdapter.getAddressUtxos(withdrawAddress)) ?? [];
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
      console.log(
        `  💧 Funding withdrawal authority from provider wallet (need ${lamportsShortfall} lamports)`
      );
      const transferIx = anchor.web3.SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: depositor.publicKey,
        lamports: lamportsShortfall,
      });
      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(transferIx)
      );
      console.log("  ✅ Funding transfer confirmed");
    }

    const globalVaultUtxos = await bitcoinAdapter.getAddressUtxos(
      globalVaultAddress
    );
    if (!globalVaultUtxos || globalVaultUtxos.length === 0) {
      throw new Error(
        `❌ No UTXOs available at global vault address ${globalVaultAddress}`
      );
    }

    const selectedUtxos: UTXO[] = [];
    let accumulated = 0;

    for (const utxo of globalVaultUtxos) {
      selectedUtxos.push(utxo);
      accumulated += utxo.value;
      if (accumulated >= totalDebit) {
        break;
      }
    }

    if (accumulated < totalDebit) {
      throw new Error(
        `❌ Unable to source sufficient global vault liquidity for ${totalDebit} sats (have ${accumulated})`
      );
    }

    const totalInputValue = selectedUtxos.reduce(
      (acc, utxo) => acc + utxo.value,
      0
    );

    console.log(
      `  ✅ Selected ${selectedUtxos.length} global vault UTXO(s) totalling ${totalInputValue} sats`
    );
    selectedUtxos.forEach((u, idx) => {
      console.log(
        `    [${idx}] txid=${u.txid}, vout=${u.vout}, value=${u.value} sats`
      );
    });

    const changeValue = totalInputValue - totalDebit;

    console.log(`  🔁 Change back to global vault: ${changeValue} sats`);

    const unsignedWithdrawTx = new bitcoin.Transaction();
    unsignedWithdrawTx.version = 2;
    selectedUtxos.forEach((utxo) => {
      unsignedWithdrawTx.addInput(
        Buffer.from(utxo.txid, "hex").reverse(),
        utxo.vout,
        0xffffffff
      );
    });
    unsignedWithdrawTx.addOutput(withdrawScript, BigInt(withdrawAmount));
    if (changeValue > 0) {
      unsignedWithdrawTx.addOutput(globalVaultScript, BigInt(changeValue));
    }
    unsignedWithdrawTx.locktime = 0;

    const withdrawTxIdDisplay = unsignedWithdrawTx.getId();
    const withdrawTxIdInternal = Buffer.from(
      withdrawTxIdDisplay,
      "hex"
    ).reverse();
    console.log("  📦 Withdrawal TXID:", withdrawTxIdDisplay);

    const requestId = RequestIdGenerator.generateSignBidirectionalRequestId(
      globalVaultAuthority.toString(),
      Array.from(withdrawTxIdInternal),
      WITHDRAW_CAIP2_ID,
      0,
      WITHDRAW_PATH,
      "ECDSA",
      "bitcoin",
      ""
    );
    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), "hex"));

    console.log("  🔑 Withdrawal Request ID:", requestId);

    const eventPromises = await setupEventListeners(provider, requestId);

    try {
      const withdrawInputs: BtcInput[] = selectedUtxos.map((utxo) => ({
        txid: Array.from(Buffer.from(utxo.txid, "hex")),
        vout: utxo.vout,
        scriptPubkey: globalVaultScript,
        value: new BN(utxo.value),
      }));

      const withdrawTxParams: BtcWithdrawParams = {
        lockTime: 0,
        caip2Id: WITHDRAW_CAIP2_ID,
        vaultScriptPubkey: globalVaultScript,
        recipientScriptPubkey: withdrawScript,
        fee: feeBn,
      };

      console.log("\n📍 STEP 1: Initiating withdrawal on Solana\n");

      console.log(
        "  💰 Balance before withdrawal:",
        startingBalance.toString(),
        "sats"
      );

      const withdrawTx = await program.methods
        .withdrawBtc(
          requestIdBytes,
          withdrawInputs,
          withdrawAmountBn,
          withdrawAddress,
          withdrawTxParams
        )
        .accounts({
          authority: depositor.publicKey,
          feePayer: provider.wallet.publicKey,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .signers([depositor])
        .rpc();

      console.log("  ✅ Withdrawal transaction sent:", withdrawTx);
      await provider.connection.confirmTransaction(withdrawTx);
      console.log("  ✅ Withdrawal transaction confirmed!");

      const balanceAfterInitiationAccount =
        await program.account.userBtcBalance.fetch(userBalancePda);
      const balanceAfterInitiation = balanceAfterInitiationAccount.amount as BN;
      const totalDebitBn = withdrawAmountBn.add(feeBn);
      const expectedAfterInitiation = startingBalance.sub(totalDebitBn);

      console.log(
        "  💰 Expected balance after initiation:",
        expectedAfterInitiation.toString(),
        "sats"
      );
      console.log(
        "  💰 Actual balance after initiation:",
        balanceAfterInitiation.toString(),
        "sats"
      );

      expect(balanceAfterInitiation.toString()).to.equal(
        expectedAfterInitiation.toString()
      );

      console.log("\n📍 STEP 2: Awaiting MPC signatures for withdrawal...\n");
      const signatureEvents = await eventPromises.waitForSignatures(
        selectedUtxos.length
      );
      console.log(
        "  ✅ Withdrawal signature events received:",
        signatureEvents.length
      );

      const signatures = signatureEvents.flatMap(extractSignatures);
      if (signatures.length !== selectedUtxos.length) {
        throw new Error(
          `Expected ${selectedUtxos.length} signature(s), received ${signatures.length}`
        );
      }

      console.log("\n📍 STEP 3: Broadcasting signed withdrawal transaction\n");

      const withdrawPsbt = btcUtils.buildPSBT(
        selectedUtxos.map((utxo) => ({
          txid: utxo.txid,
          vout: utxo.vout,
          value: utxo.value,
          scriptPubkey: globalVaultScript,
        })),
        [
          { script: withdrawScript, value: withdrawAmount },
          ...(changeValue > 0
            ? [
                {
                  script: globalVaultScript,
                  value: changeValue,
                },
              ]
            : []),
        ]
      );

      signatures.forEach((sig, idx) => {
        const { witness: withdrawWitness } = prepareSignatureWitness(
          sig,
          compressedGlobalVaultPubkey
        );
        withdrawPsbt.updateInput(idx, {
          finalScriptWitness: withdrawWitness,
        });
      });

      const signedWithdrawTx = withdrawPsbt.extractTransaction();
      const withdrawTxHex = signedWithdrawTx.toHex();
      const withdrawTxId = signedWithdrawTx.getId();

      console.log(
        "  📦 Signed withdrawal tx hex:",
        withdrawTxHex.slice(0, 64) + "..."
      );
      console.log("  📝 Withdrawal Bitcoin TxID:", withdrawTxId);

      const submittedTxid = await bitcoinAdapter.broadcastTransaction(
        withdrawTxHex
      );
      console.log("  ✅ Withdrawal transaction broadcast to Bitcoin network");
      console.log("  📝 Submitted TxID:", submittedTxid);

      if (bitcoinAdapter.mineBlocks && CONFIG.BITCOIN_NETWORK === "regtest") {
        await bitcoinAdapter.mineBlocks(1);
        console.log("  ⛏️  Mined 1 confirmation block");
      }

      console.log("\n📍 STEP 4: Waiting for verification response...\n");
      const readEvent = await eventPromises.readRespond;
      console.log("  ✅ Verification response received!");

      console.log("\n📍 STEP 5: Completing withdrawal on Solana\n");
      const completeTx = await program.methods
        .completeWithdrawBtc(
          requestIdBytes,
          Buffer.from(readEvent.serializedOutput),
          readEvent.signature,
          null
        )
        .rpc();

      console.log("  ✅ Complete withdrawal transaction sent:", completeTx);
      await provider.connection.confirmTransaction(completeTx);
      console.log("  ✅ Withdrawal completion confirmed!");

      const expectedRecipientBalance = initialRecipientBalance + withdrawAmount;
      let latestRecipientBalance = 0;

      for (let attempt = 0; attempt < 15; attempt++) {
        const utxos =
          (await bitcoinAdapter.getAddressUtxos(withdrawAddress)) ?? [];
        latestRecipientBalance = utxos.reduce(
          (acc, utxo) => acc + utxo.value,
          0
        );
        if (latestRecipientBalance >= expectedRecipientBalance) {
          break;
        }
        console.log(
          `  ⏳ Waiting for recipient balance update (attempt ${
            attempt + 1
          }/15). Current: ${latestRecipientBalance} sats`
        );
        await sleep(2_000);
      }

      console.log(
        "  💰 Recipient balance before withdrawal:",
        initialRecipientBalance,
        "sats"
      );
      console.log(
        "  💰 Recipient balance after withdrawal:",
        latestRecipientBalance,
        "sats"
      );
      console.log(
        "  💰 Expected recipient balance:",
        expectedRecipientBalance,
        "sats"
      );

      expect(latestRecipientBalance).to.be.at.least(expectedRecipientBalance);

      const finalBalanceAccount = await program.account.userBtcBalance.fetch(
        userBalancePda
      );
      const balanceAfter = finalBalanceAccount.amount as BN;

      console.log("\n📍 STEP 6: Verifying post-withdrawal balance\n");
      console.log(
        "  💰 Balance after initiation:",
        balanceAfterInitiation.toString(),
        "sats"
      );
      console.log("  💰 Final balance:", balanceAfter.toString(), "sats");

      expect(balanceAfter.toString()).to.equal(
        balanceAfterInitiation.toString()
      );

      const [pendingWithdrawPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pending_btc_withdrawal"), Buffer.from(requestIdBytes)],
        program.programId
      );

      const pendingWithdrawal =
        await program.account.pendingBtcWithdrawal.fetchNullable(
          pendingWithdrawPda
        );
      expect(pendingWithdrawal).to.be.null;
      console.log("  ✅ Pending withdrawal account closed");

      console.log("\n" + "=".repeat(80));
      console.log("🎉 Bitcoin Withdrawal Flow Completed Successfully!");
      console.log("=".repeat(80) + "\n");
    } finally {
      await cleanupEventListeners(eventPromises);
    }
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

  console.log("  🔍 Setting up event listeners for requestId:", requestId);

  const unsubscribe = await signetContract.subscribeToEvents({
    onSignatureResponded: (event: SignatureRespondedEventPayload, slot) => {
      const eventRequestId =
        "0x" + Buffer.from(event.requestId).toString("hex");

      console.log("  📨 [EVENT] onSignatureResponded fired!");
      console.log("    - Slot:", slot);
      console.log("    - Event requestId:", eventRequestId);
      console.log("    - Expected requestId:", requestId);
      console.log("    - Match:", eventRequestId === requestId);

      if (eventRequestId === requestId) {
        matchedSignatureEvents.push(event);
        console.log(
          "  ✅ Signature event MATCHED! Total signatures collected:",
          matchedSignatureEvents.length
        );

        if (!firstSignatureResolved) {
          firstSignatureResolved = true;
          signatureResolve(event);
        }
        resolveSignatureWaiters();
      } else {
        console.log("  ⚠️  Signature event did NOT match, ignoring...");
      }
    },
    onSignatureError: (event, slot) => {
      const eventRequestId =
        "0x" + Buffer.from(event.requestId).toString("hex");

      console.log("  ❌ [EVENT] onSignatureError fired!");
      console.log("    - Slot:", slot);
      console.log("    - Event requestId:", eventRequestId);
      console.log("    - Expected requestId:", requestId);
      console.log("    - Error:", event.error);
      console.log("    - Match:", eventRequestId === requestId);

      if (eventRequestId === requestId) {
        console.error("  ❌ Signature ERROR MATCHED! Rejecting promise...");
        const error = new Error(event.error);
        signatureReject(error);
        rejectSignatureWaiters(error);
      } else {
        console.log("  ⚠️  Signature error did NOT match, ignoring...");
      }
    },
  });

  const program: Program<ChainSignaturesProject> =
    new anchor.Program<ChainSignaturesProject>(IDL, provider);

  console.log("  🔍 Setting up respondBidirectionalEvent listener...");

  const readRespondListener = program.addEventListener(
    "respondBidirectionalEvent",
    (event: RespondBidirectionalEventPayload, slot: number) => {
      const eventRequestId =
        "0x" + Buffer.from(event.requestId).toString("hex");

      console.log("  📨 [EVENT] respondBidirectionalEvent fired!");
      console.log("    - Event requestId:", eventRequestId);
      console.log("    - Expected requestId:", requestId);
      console.log("    - Match:", eventRequestId === requestId);
      console.log("    - Serialized output:", event.serializedOutput);
      if (slot !== undefined) {
        console.log("    - Slot:", slot);
      }

      if (eventRequestId === requestId) {
        console.log("  ✅ Read/respond event MATCHED! Resolving...");
        readRespondResolve(event);
      } else {
        console.log("  ⚠️  Read/respond event did NOT match, ignoring...");
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
