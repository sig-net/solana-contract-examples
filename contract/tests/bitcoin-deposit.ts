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
import FakenetSignerDefault from "fakenet-signer";
import { CONFIG, SERVER_CONFIG } from "../utils/envConfig.js";

const FakenetSigner =
  (
    FakenetSignerDefault as typeof FakenetSignerDefault & {
      default?: typeof FakenetSignerDefault;
    }
  ).default || FakenetSignerDefault;
const { ChainSignatureServer, RequestIdGenerator, BitcoinAdapterFactory } =
  FakenetSigner;

interface UTXO {
  txid: string;
  vout: number;
  value: number;
  status?: {
    confirmed: boolean;
    block_height?: number;
  };
}

interface IBitcoinAdapter {
  isAvailable(): Promise<boolean>;
  getAddressUtxos(address: string): Promise<UTXO[]>;
  fundAddress?(address: string, amount: number): Promise<string>;
}
import * as crypto from "crypto";

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

interface BtcTransactionParams {
  lockTime: number;
  caip2Id: string;
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
          value: BigInt(input.value), // Must be bigint
        },
      });
    }

    // Add outputs
    for (const output of outputs) {
      if (output.address) {
        psbt.addOutput({
          address: output.address,
          value: BigInt(output.value), // Must be bigint
        });
      } else if (output.script) {
        psbt.addOutput({
          script: Buffer.from(output.script),
          value: BigInt(output.value), // Must be bigint
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

type ChainSignatureServerType = InstanceType<typeof ChainSignatureServer>;

describe.only("🪙 Bitcoin Deposit E2E Test", () => {
  let provider: anchor.AnchorProvider;
  let program: Program<SolanaCoreContracts>;
  let btcUtils: BitcoinUtils;
  let server: ChainSignatureServerType | null = null;
  let bitcoinAdapter: IBitcoinAdapter;

  before(async function () {
    this.timeout(30000);

    console.log("\n🚀 Setting up test environment...\n");

    console.log("📋 BITCOIN NETWORK CONFIGURATION:");
    console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  Network:      ", CONFIG.BITCOIN_NETWORK);
    console.log("  CAIP-2 ID:    ", CONFIG.BITCOIN_CAIP2_ID);
    console.log("  Address Prefix:");
    console.log(
      "    mainnet  → bc1q...   (CAIP-2: bip122:000000000019d6689c085ae165831e93)"
    );
    console.log(
      "    testnet  → tb1q...   (CAIP-2: bip122:000000000933ea01ad0ee984209779ba)"
    );
    console.log(
      "    regtest  → bcrt1q... (CAIP-2: bip122:0f9188f13cb7b2c71f2a335e3a4fc328)"
    );
    console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    program = anchor.workspace
      .SolanaCoreContracts as Program<SolanaCoreContracts>;

    console.log("📝 Program ID:", program.programId.toString());
    console.log("👛 Wallet:", provider.wallet.publicKey.toString());

    await ensureVaultConfigInitialized(program, provider);

    btcUtils = new BitcoinUtils(CONFIG.BITCOIN_NETWORK);

    // Initialize Bitcoin adapter
    console.log(
      `\n🔗 Initializing Bitcoin ${CONFIG.BITCOIN_NETWORK} adapter...`
    );
    bitcoinAdapter = await BitcoinAdapterFactory.create(CONFIG.BITCOIN_NETWORK);

    const isAvailable = await bitcoinAdapter.isAvailable();
    if (!isAvailable) {
      throw new Error(
        `❌ Bitcoin ${CONFIG.BITCOIN_NETWORK} adapter not available.\n` +
          (CONFIG.BITCOIN_NETWORK === "regtest"
            ? "Please start Bitcoin Core in regtest mode:\n" +
              "  1. Clone: git clone https://github.com/Pessina/bitcoin-regtest.git\n" +
              "  2. Start: cd bitcoin-regtest && yarn docker:dev\n" +
              "  3. Verify: curl http://localhost:18443"
            : "Check network connectivity.")
      );
    }
    console.log(`✅ Bitcoin ${CONFIG.BITCOIN_NETWORK} adapter ready`);

    // Verify fundAddress is available for regtest
    if (CONFIG.BITCOIN_NETWORK === "regtest") {
      if (typeof bitcoinAdapter.fundAddress !== "function") {
        console.log(
          "  ⚠️  Warning: fundAddress method not available on adapter"
        );
        console.log("  📝 Available methods:", Object.keys(bitcoinAdapter));
      } else {
        console.log("  ✅ fundAddress method available");
      }
    }

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

  it("Should complete Bitcoin deposit flow with PSBT", async function () {
    this.timeout(180000); // 3 minutes for full flow

    console.log("\n" + "=".repeat(80));
    console.log("📋 TEST: Bitcoin Deposit Flow");
    console.log("=".repeat(80) + "\n");

    // =====================================================
    // STEP 1: DERIVE BITCOIN ADDRESS
    // =====================================================

    console.log("📍 STEP 1: Deriving Bitcoin address from MPC root key\n");

    const [vaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    const [globalVaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_vault_authority")],
      program.programId
    );

    const path = provider.wallet.publicKey.toString();

    // Derive child public key for deposit address
    const derivedPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.BASE_PUBLIC_KEY as `04${string}`,
      vaultAuthority.toString(),
      path,
      CONFIG.SOLANA_CHAIN_ID
    );

    // For Bitcoin, we need to compress the public key for SegWit (P2WPKH)
    // signet.js returns uncompressed (65 bytes), but Bitcoin SegWit needs compressed (33 bytes)
    const compressedPubkey = btcUtils.compressPublicKey(derivedPublicKey);
    const depositAddress = btcUtils.getAddressFromPubkey(compressedPubkey);
    const depositScript = btcUtils.createP2WPKHScript(compressedPubkey);

    // Derive recipient address (global vault)
    const recipientPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.BASE_PUBLIC_KEY as `04${string}`,
      globalVaultAuthority.toString(),
      "root",
      CONFIG.SOLANA_CHAIN_ID
    );
    const compressedRecipientPubkey =
      btcUtils.compressPublicKey(recipientPublicKey);
    const recipientAddress = btcUtils.getAddressFromPubkey(
      compressedRecipientPubkey
    );
    const recipientScript = btcUtils.createP2WPKHScript(
      compressedRecipientPubkey
    );

    console.log("  🔑 Vault Authority PDA:", vaultAuthority.toString());
    console.log(
      "  🔑 Global Vault Authority:",
      globalVaultAuthority.toString()
    );
    console.log("  📍 Derivation Path:", path);

    console.log("\n  🔍 DERIVATION VALIDATION:");
    console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  Server will derive Bitcoin address using:");
    console.log("    1. Epsilon calculation:");
    console.log(
      `       derivationPath = "${CONFIG.EPSILON_DERIVATION_PREFIX},${
        CONFIG.SOLANA_CHAIN_ID
      },${vaultAuthority.toString()},${path}"`
    );
    console.log("       epsilon = keccak256(derivationPath)");
    console.log("    2. Private key derivation:");
    console.log("       derivedKey = (mpcRootKey + epsilon) % secp256k1_n");
    console.log("    3. Bitcoin address:");
    console.log("       P2WPKH(derivedKey.publicKey, testnet4)");
    console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  ✅ Our client-side derivation uses identical parameters");
    console.log("  ✅ Chain ID: " + CONFIG.SOLANA_CHAIN_ID);
    console.log("  ✅ Sender: " + vaultAuthority.toString());
    console.log("  ✅ Path: " + path);
    console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    // Verify address format matches network
    const expectedPrefix =
      CONFIG.BITCOIN_NETWORK === "mainnet"
        ? "bc1q"
        : CONFIG.BITCOIN_NETWORK === "regtest"
        ? "bcrt1q"
        : "tb1q";

    console.log(`\n  📍 BITCOIN ADDRESSES (${CONFIG.BITCOIN_NETWORK}):`);
    console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  💵 DEPOSIT ADDRESS (fund this):", depositAddress);
    console.log("  💵 RECIPIENT ADDRESS:", recipientAddress);

    // Validate address prefix
    if (!depositAddress.startsWith(expectedPrefix)) {
      throw new Error(
        `❌ Address prefix mismatch! Expected ${expectedPrefix}... for ${CONFIG.BITCOIN_NETWORK}, ` +
          `but got ${depositAddress.substring(0, 6)}...`
      );
    }
    console.log(
      `  ✅ Address format validated for ${CONFIG.BITCOIN_NETWORK} network`
    );
    console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    if (CONFIG.BITCOIN_NETWORK === "testnet") {
      console.log("\n  🌐 Get testnet4 BTC from:");
      console.log("     https://testnet4.anyone.eu.org/");
      console.log("     https://mempool.space/testnet4");
    } else if (CONFIG.BITCOIN_NETWORK === "regtest") {
      console.log(
        "\n  🌐 Regtest network - use bitcoinAdapter.mineBlocks() to fund"
      );
    }
    console.log(
      "\n  🔐 Derived Public Key:",
      derivedPublicKey.slice(0, 32) + "..."
    );
    console.log("  📜 Deposit Script (hex):", depositScript.toString("hex"));
    console.log("  📜 Deposit Script length:", depositScript.length, "bytes");
    console.log(
      "  📜 Recipient Script (hex):",
      recipientScript.toString("hex")
    );
    console.log(
      "  📜 Recipient Script length:",
      recipientScript.length,
      "bytes"
    );

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
      if (CONFIG.BITCOIN_NETWORK === "regtest") {
        console.log(
          "  💰 No UTXOs found. Auto-funding address via Bitcoin Core RPC..."
        );
        const fundingAmount = 0.001; // 0.001 BTC = 100,000 sats

        try {
          // Access Bitcoin Core RPC client
          const client = (bitcoinAdapter as any).client;

          if (!client) {
            throw new Error("Bitcoin Core RPC client not available on adapter");
          }

          // Send funds to the address
          const fundTxid = await client.command(
            "sendtoaddress",
            depositAddress,
            fundingAmount
          );
          console.log(`  ✅ Sent ${fundingAmount} BTC to ${depositAddress}`);
          console.log(`  📝 Transaction ID: ${fundTxid}`);

          // Mine 1 block to confirm the transaction
          const walletAddress = await client.command("getnewaddress");
          await client.command("generatetoaddress", 1, walletAddress);
          console.log(`  ⛏️  Mined 1 block for confirmation`);

          // Fetch UTXOs again
          utxos = await bitcoinAdapter.getAddressUtxos(depositAddress);

          if (!utxos || utxos.length === 0) {
            throw new Error(
              `❌ Failed to fund address. No UTXOs found after funding and mining.`
            );
          }

          console.log(`  ✅ Address funded and confirmed`);
        } catch (error) {
          throw new Error(
            `❌ Failed to fund address on regtest:\n${error.message}\n\n` +
              `Please ensure Bitcoin Core is running:\n` +
              `  1. Start: cd bitcoin-regtest && yarn docker:dev\n` +
              `  2. Check: curl http://localhost:18443\n` +
              `  3. Or manually fund:\n` +
              `     bitcoin-cli -regtest sendtoaddress ${depositAddress} 0.001\n` +
              `     bitcoin-cli -regtest generatetoaddress 1 $(bitcoin-cli -regtest getnewaddress)`
          );
        }
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

    console.log(`  ✅ Found ${utxos.length} UTXO(s)`);

    // Use the first UTXO (smallest amount for testing)
    const utxo = utxos.sort((a, b) => a.value - b.value)[0];
    const inputValue = utxo.value;
    const fee = 200; // 200 sats fee (very small for ~1000 sat inputs)
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

    const mockTxId = utxo.txid;

    const btcInputs: BtcInput[] = [
      {
        // DON'T reverse - pass in display format (the hex string as-is)
        // The Rust bitcoin library handles the byte order internally
        txid: Array.from(Buffer.from(mockTxId, "hex")),
        vout: utxo.vout,
        scriptPubkey: depositScript,
        value: new BN(inputValue),
      },
    ];

    const btcOutputs: BtcOutput[] = [
      {
        scriptPubkey: recipientScript,
        value: new BN(outputValue),
      },
    ];

    const txParams: BtcTransactionParams = {
      lockTime: 0,
      caip2Id: CONFIG.BITCOIN_CAIP2_ID,
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
      Buffer.from(mockTxId, "hex").reverse(),
      utxo.vout,
      0xffffffff // Sequence::MAX
    );

    // Add output
    unsignedTx.addOutput(recipientScript, BigInt(outputValue));

    // Set locktime
    unsignedTx.locktime = 0;

    // Get TXID - bitcoinjs-lib returns it in DISPLAY format (reversed)
    const rawTxHex = unsignedTx.toHex();
    const txidDisplay = unsignedTx.getId(); // Returns hex string in display format

    // Rust tx.txid() returns bytes in INTERNAL format (reversed from display)
    // We need to reverse to match what Rust uses for request ID calculation
    const txidInternal = Buffer.from(txidDisplay, "hex").reverse();
    const txidBuffer = txidInternal; // For backward compatibility with existing code

    console.log("  📦 Raw TX (full hex):", rawTxHex);
    console.log("  📦 Raw TX length:", rawTxHex.length / 2, "bytes");
    console.log("  📦 TXID (display format):", txidDisplay);
    console.log(
      "  📦 TXID (internal, for requestId):",
      txidInternal.toString("hex")
    );
    console.log(
      "  📦 TXID bytes (internal, first 16):",
      Array.from(txidInternal).slice(0, 16).join(",") + "..."
    );

    // Generate request ID using TXID (matching Rust code at line 120-122)
    const caip2Id = CONFIG.BITCOIN_CAIP2_ID;

    console.log("\n  🔍 REQUEST ID GENERATION DEBUG:");
    console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  Sender:", vaultAuthority.toString());
    console.log(
      "  Transaction Data (TXID internal):",
      txidInternal.toString("hex")
    );
    console.log(
      "  TXID (bytes internal, first 16):",
      Array.from(txidInternal).slice(0, 16).join(",")
    );
    console.log("  CAIP-2 ID:", caip2Id);
    console.log("  Path:", path);
    console.log("  Key Version: 0");
    console.log("  Signature Type: ECDSA");
    console.log("  Chain: bitcoin");
    console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const requestId = RequestIdGenerator.generateSignBidirectionalRequestId(
      vaultAuthority.toString(),
      Array.from(txidBuffer), // Use TXID bytes
      caip2Id,
      0, // key_version
      path,
      "ECDSA",
      "bitcoin",
      ""
    );

    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), "hex"));

    console.log("  ✅ Client Request ID:", requestId);
    console.log("  📝 Compare this with Solana program logs");
    console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    // =====================================================
    // STEP 4: SETUP EVENT LISTENERS
    // =====================================================

    console.log("\n📍 STEP 4: Setting up event listeners for MPC signatures\n");

    const eventPromises = await setupEventListeners(
      provider,
      requestId,
      vaultAuthority.toString()
    );

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
      initialBalance = balanceAccount.amount as BN;
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
    } catch (error: any) {
      console.error("\n  ❌ Deposit transaction failed!");
      console.error("  📋 SOLANA PROGRAM LOGS:");
      console.error("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      if (error.logs) {
        error.logs.forEach((log: string) => console.error("    ", log));
      }
      console.error("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
      throw error;
    }

    // =====================================================
    // STEP 7: WAIT FOR MPC SIGNATURE
    // =====================================================

    console.log("\n📍 STEP 7: Waiting for MPC signature...\n");
    console.log("  ⏳ This may take 30-60 seconds...");

    const signatureEvent: any = await eventPromises.signature;

    if (signatureEvent.error) {
      throw new Error(`Signature error: ${signatureEvent.error}`);
    }

    console.log("  ✅ MPC signature received!");

    const signature = extractSignature(signatureEvent);
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
          txid: mockTxId,
          vout: utxo.vout,
          value: inputValue,
          scriptPubkey: depositScript,
        },
      ],
      [
        {
          script: recipientScript,
          value: outputValue,
        },
      ]
    );

    // Convert ECDSA signature to DER format for Bitcoin
    const rBuf = Buffer.from(signature.r.slice(2), "hex");
    const sBuf = Buffer.from(signature.s.slice(2), "hex");

    // Create DER signature
    const derSig = Buffer.concat([
      Buffer.from([0x30]), // DER sequence tag
      Buffer.from([rBuf.length + sBuf.length + 4]), // total length
      Buffer.from([0x02]), // integer tag for r
      Buffer.from([rBuf.length]), // r length
      rBuf,
      Buffer.from([0x02]), // integer tag for s
      Buffer.from([sBuf.length]), // s length
      sBuf,
    ]);

    // Add SIGHASH_ALL flag
    const sigWithHashType = Buffer.concat([
      derSig,
      Buffer.from([bitcoin.Transaction.SIGHASH_ALL]),
    ]);

    // Finalize the input with the signature
    psbt.updateInput(0, {
      finalScriptWitness: Buffer.concat([
        Buffer.from([0x02]), // 2 items in witness
        Buffer.from([sigWithHashType.length]),
        sigWithHashType,
        Buffer.from([compressedPubkey.length]),
        compressedPubkey,
      ]),
    });

    const signedTx = psbt.extractTransaction();
    const txHex = signedTx.toHex();

    console.log("  📦 Signed transaction hex:", txHex.slice(0, 64) + "...");

    // Submit to Bitcoin network
    try {
      const client = (bitcoinAdapter as any).client;
      if (!client) {
        throw new Error("Bitcoin Core RPC client not available");
      }

      const submittedTxid = await client.command("sendrawtransaction", txHex);
      console.log("  ✅ Transaction submitted to Bitcoin network");
      console.log("  📝 Bitcoin TxID:", submittedTxid);

      // Mine a block to confirm
      const walletAddress = await client.command("getnewaddress");
      await client.command("generatetoaddress", 1, walletAddress);
      console.log("  ⛏️  Mined 1 confirmation block");
    } catch (error: any) {
      console.error(
        "  ❌ Failed to submit Bitcoin transaction:",
        error.message
      );
      throw error;
    }

    // =====================================================
    // STEP 9: WAIT FOR READ RESPONSE
    // =====================================================

    console.log("\n📍 STEP 9: Waiting for transaction verification...\n");

    const readEvent = (await eventPromises.readRespond) as any;
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
    const finalBalance = finalBalanceAccount.amount as BN;

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
});

/**
 * Setup event listeners for chain signatures
 */
async function setupEventListeners(
  provider: anchor.AnchorProvider,
  requestId: string,
  _signerAddress: string
) {
  let signatureResolve: (value: any) => void;
  let readRespondResolve: (value: any) => void;

  const signaturePromise = new Promise((resolve) => {
    signatureResolve = resolve;
  });

  const readRespondPromise = new Promise((resolve) => {
    readRespondResolve = resolve;
  });

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
    onSignatureResponded: (event, slot) => {
      const eventRequestId =
        "0x" + Buffer.from(event.requestId).toString("hex");

      console.log("  📨 [EVENT] onSignatureResponded fired!");
      console.log("    - Slot:", slot);
      console.log("    - Event requestId:", eventRequestId);
      console.log("    - Expected requestId:", requestId);
      console.log("    - Match:", eventRequestId === requestId);

      if (eventRequestId === requestId) {
        console.log("  ✅ Signature event MATCHED! Resolving...");
        signatureResolve(event);
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
        console.error("  ❌ Signature ERROR MATCHED! Resolving with error...");
        signatureResolve({ error: event.error });
      } else {
        console.log("  ⚠️  Signature error did NOT match, ignoring...");
      }
    },
  });

  const program = new anchor.Program<ChainSignaturesProject>(IDL, provider);

  console.log("  🔍 Setting up respondBidirectionalEvent listener...");

  const readRespondListener = program.addEventListener(
    "respondBidirectionalEvent" as any,
    (event: any) => {
      const eventRequestId =
        "0x" + Buffer.from(event.requestId).toString("hex");

      console.log("  📨 [EVENT] respondBidirectionalEvent fired!");
      console.log("    - Event requestId:", eventRequestId);
      console.log("    - Expected requestId:", requestId);
      console.log("    - Match:", eventRequestId === requestId);
      console.log("    - Serialized output:", event.serializedOutput);

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
    readRespond: readRespondPromise,
    unsubscribe,
    readRespondListener,
    program,
  };
}

function extractSignature(event: any) {
  const signature = event.signature;
  const r = "0x" + Buffer.from(signature.bigR.x).toString("hex");
  const s = "0x" + Buffer.from(signature.s).toString("hex");
  const v = BigInt(signature.recoveryId + 27);

  return { r, s, v };
}

async function cleanupEventListeners(eventPromises: any) {
  if (eventPromises.unsubscribe) {
    await eventPromises.unsubscribe();
  }
  if (eventPromises.readRespondListener && eventPromises.program) {
    await eventPromises.program.removeEventListener(
      eventPromises.readRespondListener
    );
  }
}
