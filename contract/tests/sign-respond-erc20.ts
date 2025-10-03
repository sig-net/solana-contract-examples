import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaCoreContracts } from "../target/types/solana_core_contracts";
import { ChainSignaturesProject } from "../types/chain_signatures_project";
import IDL from "../idl/chain_signatures_project.json";
import { expect } from "chai";
import { ethers } from "ethers";
import { contracts } from "signet.js";
import { secp256k1 } from "@noble/curves/secp256k1";

const CONFIG = {
  // API Keys
  INFURA_API_KEY: "6df51ccaa17f4e078325b5050da5a2dd",

  // Contract Addresses
  USDC_ADDRESS_SEPOLIA: "0xbe72E441BF55620febc26715db68d3494213D8Cb",
  HARDCODED_RECIPIENT: "0xdcF0f02E13eF171aA028Bc7d4c452CFCe3C2E18f",

  // Chain Configuration
  SEPOLIA_CHAIN_ID: 11155111,
  ETHEREUM_SLIP44: 60,
  ETHEREUM_CAIP2_ID: "eip155:11155111",

  // Fakenet Osman
  // BASE_PUBLIC_KEY:
  //   "0x044eef776e4f257d68983e45b340c2e9546c5df95447900b6aadfec68fb46fdee257e26b8ba383ddba9914b33c60e869265f859566fff4baef283c54d821ca3b64",

  // Felipe Local Public Key
  BASE_PUBLIC_KEY:
    "0x04bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4",

  EPSILON_DERIVATION_PREFIX: "sig.network v1.0.0 epsilon derivation",
  SOLANA_CHAIN_ID: "0x800001f5",

  // Timing
  WAIT_FOR_FUNDING_MS: 5000,

  // Test Parameters
  TRANSFER_AMOUNT: "0.1", // USDC
  DECIMALS: 6,
  GAS_BUFFER_PERCENT: 20,

  // Solana Programs
  CHAIN_SIGNATURES_PROGRAM_ID: "85hZuPHErQ6y1o59oMGjVCjHz4xgzKzjVCpgPm6kdBTV",
} as const;

interface TransactionParams {
  nonce: anchor.BN;
  value: anchor.BN;
  maxPriorityFeePerGas: anchor.BN;
  maxFeePerGas: anchor.BN;
  gasLimit: anchor.BN;
  chainId: anchor.BN;
}

interface Point {
  x: bigint;
  y: bigint;
}

class CryptoUtils {
  /**
   * Derive epsilon value for key derivation
   */
  static deriveEpsilon(requester: string, path: string): bigint {
    const derivationPath = `${CONFIG.EPSILON_DERIVATION_PREFIX},${CONFIG.SOLANA_CHAIN_ID},${requester},${path}`;
    console.log("📝 Derivation path:", derivationPath);
    const hash = ethers.keccak256(ethers.toUtf8Bytes(derivationPath));
    return BigInt(hash);
  }

  /**
   * Convert public key string to elliptic curve point
   */
  static publicKeyToPoint(publicKey: string): Point {
    const cleanPubKey = publicKey.slice(4); // Remove 0x04 prefix
    const x = cleanPubKey.slice(0, 64);
    const y = cleanPubKey.slice(64, 128);
    return {
      x: BigInt("0x" + x),
      y: BigInt("0x" + y),
    };
  }

  /**
   * Convert elliptic curve point to public key string
   */
  static pointToPublicKey(point: Point): string {
    const x = point.x.toString(16).padStart(64, "0");
    const y = point.y.toString(16).padStart(64, "0");
    return "0x04" + x + y;
  }

  /**
   * Derive public key using epsilon and base public key
   */
  static derivePublicKey(
    path: string,
    requesterAddress: string,
    basePublicKey: string
  ): string {
    try {
      const epsilon = this.deriveEpsilon(requesterAddress, path);
      const basePoint = this.publicKeyToPoint(basePublicKey);

      // Calculate epsilon * G
      const epsilonPoint = secp256k1.ProjectivePoint.BASE.multiply(epsilon);

      // Convert base point to projective
      const baseProjectivePoint = new secp256k1.ProjectivePoint(
        basePoint.x,
        basePoint.y,
        BigInt(1)
      );

      // Add points: result = base + epsilon * G
      const resultPoint = epsilonPoint.add(baseProjectivePoint);
      const resultAffine = resultPoint.toAffine();

      const derivedPublicKey = this.pointToPublicKey({
        x: resultAffine.x,
        y: resultAffine.y,
      });

      console.log("🔑 Derived public key:", derivedPublicKey);
      return derivedPublicKey;
    } catch (error) {
      console.error("❌ Error deriving public key:", error);
      throw error;
    }
  }

  static generateSignBidirectionalRequestId(
    sender: string,
    transactionData: number[],
    caip2Id: string,
    keyVersion: number,
    path: string,
    algo: string,
    dest: string,
    params: string
  ): string {
    const txDataHex = "0x" + Buffer.from(transactionData).toString("hex");
    const encoded = ethers.solidityPacked(
      [
        "string",
        "bytes",
        "string",
        "uint32",
        "string",
        "string",
        "string",
        "string",
      ],
      [sender, txDataHex, caip2Id, keyVersion, path, algo, dest, params]
    );

    return ethers.keccak256(encoded);
  }
}

class EthereumUtils {
  private provider: ethers.JsonRpcProvider;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(
      `https://sepolia.infura.io/v3/${CONFIG.INFURA_API_KEY}`
    );
  }

  /**
   * Get the provider instance
   */
  getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }

  /**
   * Build ERC20 transfer transaction
   */
  async buildTransferTransaction(
    from: string,
    amount: bigint
  ): Promise<{
    callData: string;
    txParams: TransactionParams;
    rlpEncodedTx: string;
    nonce: number;
  }> {
    // Get current nonce
    const nonce = await this.provider.getTransactionCount(from);
    console.log("📊 Current nonce:", nonce);

    // Build call data
    const transferInterface = new ethers.Interface([
      "function transfer(address to, uint256 amount) returns (bool)",
    ]);
    const callData = transferInterface.encodeFunctionData("transfer", [
      CONFIG.HARDCODED_RECIPIENT,
      amount,
    ]);

    // Get gas prices
    const feeData = await this.provider.getFeeData();
    const maxFeePerGas =
      feeData.maxFeePerGas || ethers.parseUnits("30", "gwei");
    const maxPriorityFeePerGas =
      feeData.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei");

    console.log("\n⛽ Gas prices:");
    console.log("  Max fee:", ethers.formatUnits(maxFeePerGas, "gwei"), "gwei");
    console.log(
      "  Priority fee:",
      ethers.formatUnits(maxPriorityFeePerGas, "gwei"),
      "gwei"
    );

    // Estimate gas
    const gasEstimate = await this.provider.estimateGas({
      from,
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      data: callData,
    });

    const gasLimit =
      (gasEstimate * BigInt(100 + CONFIG.GAS_BUFFER_PERCENT)) / BigInt(100);
    console.log("  Gas limit (with buffer):", gasLimit.toString());

    // Create transaction params
    const txParams: TransactionParams = {
      nonce: new anchor.BN(nonce),
      value: new anchor.BN(0),
      maxPriorityFeePerGas: new anchor.BN(maxPriorityFeePerGas.toString()),
      maxFeePerGas: new anchor.BN(maxFeePerGas.toString()),
      gasLimit: new anchor.BN(gasLimit.toString()),
      chainId: new anchor.BN(CONFIG.SEPOLIA_CHAIN_ID),
    };

    // Build RLP-encoded transaction
    const tempTx = {
      type: 2, // EIP-1559
      chainId: CONFIG.SEPOLIA_CHAIN_ID,
      nonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit,
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      value: BigInt(0),
      data: callData,
    };

    const rlpEncodedTx = ethers.Transaction.from(tempTx).unsignedSerialized;

    return {
      callData,
      txParams,
      rlpEncodedTx: ethers.hexlify(rlpEncodedTx),
      nonce,
    };
  }

  /**
   * Submit signed transaction to Ethereum
   */
  async submitTransaction(signedTx: ethers.Transaction): Promise<string> {
    console.log("\n📡 Broadcasting transaction to Sepolia...");
    const txHash = await this.provider.send("eth_sendRawTransaction", [
      signedTx.serialized,
    ]);
    console.log("  🔗 Transaction hash:", txHash);
    return txHash;
  }

  /**
   * Wait for transaction confirmation
   */
  async waitForConfirmation(
    txHash: string
  ): Promise<ethers.TransactionReceipt> {
    console.log("\n⏳ Waiting for transaction confirmation...");
    const receipt = await this.provider.waitForTransaction(txHash, 1);
    if (!receipt) {
      throw new Error("Transaction receipt not found");
    }
    console.log("  ✅ Confirmed in block:", receipt.blockNumber);
    console.log(
      "  📊 Status:",
      receipt.status === 1 ? "Success ✅" : "Failed ❌"
    );
    return receipt;
  }
}

describe("🏦 ERC20 Deposit, Withdraw and Withdraw with refund Flow", () => {
  // Test context
  let provider: anchor.AnchorProvider;
  let program: Program<SolanaCoreContracts>;
  let ethUtils: EthereumUtils;

  before(() => {
    // Setup Anchor provider
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    // Initialize programs
    program = anchor.workspace
      .SolanaCoreContracts as Program<SolanaCoreContracts>;

    // Initialize Ethereum utilities
    ethUtils = new EthereumUtils();
  });

  it("Should complete full ERC20 deposit flow", async function () {
    console.log("\n🚀 Starting ERC20 Deposit Flow Test\n");

    // =====================================================
    // STEP 1: DERIVE ADDRESSES
    // =====================================================

    console.log("📍 Step 1: Deriving addresses...");

    const [vaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    const path = provider.wallet.publicKey.toString();
    const derivedPublicKey = CryptoUtils.derivePublicKey(
      path,
      vaultAuthority.toString(),
      CONFIG.BASE_PUBLIC_KEY
    );
    const derivedAddress = ethers.computeAddress(derivedPublicKey);

    console.log("  👛 Solana wallet:", provider.wallet.publicKey.toString());
    console.log("  📂 Path:", path);
    console.log("  🔑 Derived Ethereum address:", derivedAddress);

    // Give user time to fund the address
    console.log("\n⚠️  Please ensure this address has USDC tokens!");
    console.log("  Waiting 5 seconds...\n");
    await new Promise((resolve) =>
      setTimeout(resolve, CONFIG.WAIT_FOR_FUNDING_MS)
    );

    // =====================================================
    // STEP 2: PREPARE TRANSACTION
    // =====================================================

    console.log("📍 Step 2: Preparing transaction...");

    // Add small randomness to amount to ensure unique request ID per test run
    const randomOffset = Math.floor(Math.random() * 1000); // 0-999 units (smallest denomination)
    const baseAmount = ethers.parseUnits(
      CONFIG.TRANSFER_AMOUNT,
      CONFIG.DECIMALS
    );
    const amountBigInt = baseAmount + BigInt(randomOffset);
    const amountBN = new anchor.BN(amountBigInt.toString());
    const erc20AddressBytes = Array.from(
      Buffer.from(CONFIG.USDC_ADDRESS_SEPOLIA.slice(2), "hex")
    );

    const { callData, txParams, rlpEncodedTx, nonce } =
      await ethUtils.buildTransferTransaction(derivedAddress, amountBigInt);

    // Generate request ID
    const requestId = CryptoUtils.generateSignBidirectionalRequestId(
      vaultAuthority.toString(),
      Array.from(ethers.getBytes(rlpEncodedTx)),
      CONFIG.ETHEREUM_CAIP2_ID,
      0, // key_version
      path,
      "ECDSA",
      "ethereum",
      ""
    );
    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), "hex"));

    // =====================================================
    // STEP 3: SETUP EVENT LISTENERS
    // =====================================================

    console.log("\n📍 Step 3: Setting up event listeners...");

    const eventPromises = await setupEventListeners(
      provider,
      requestId,
      derivedAddress,
      rlpEncodedTx
    );

    // =====================================================
    // STEP 4: DEPOSIT ERC20
    // =====================================================

    console.log("\n📍 Step 4: Initiating deposit...");

    const accounts = await getDepositAccounts(
      program,
      provider,
      requestIdBytes,
      erc20AddressBytes
    );

    // Check initial balance
    const initialBalance = await getInitialBalance(
      program,
      accounts.userBalance
    );

    const recipientAddressBytes = Array.from(
      Buffer.from(CONFIG.HARDCODED_RECIPIENT.slice(2), "hex")
    );

    const depositTx = await program.methods
      .depositErc20(
        requestIdBytes as any,
        provider.wallet.publicKey,
        erc20AddressBytes as any,
        recipientAddressBytes as any,
        amountBN,
        txParams
      )
      .accounts({
        payer: provider.wallet.publicKey,
        feePayer: provider.wallet.publicKey,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();

    console.log("  ✅ Deposit transaction:", depositTx);

    // =====================================================
    // STEP 5: WAIT FOR SIGNATURE
    // =====================================================

    console.log("\n📍 Step 5: Waiting for signature...");

    const signatureEvent = (await eventPromises.signature) as any;
    const signature = extractSignature(signatureEvent);

    // =====================================================
    // STEP 6: SUBMIT TO ETHEREUM
    // =====================================================

    console.log("\n📍 Step 6: Submitting to Ethereum...");

    const signedTx = ethers.Transaction.from({
      type: 2,
      chainId: CONFIG.SEPOLIA_CHAIN_ID,
      nonce,
      maxPriorityFeePerGas: BigInt(txParams.maxPriorityFeePerGas.toString()),
      maxFeePerGas: BigInt(txParams.maxFeePerGas.toString()),
      gasLimit: BigInt(txParams.gasLimit.toString()),
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      value: BigInt(0),
      data: callData,
      signature,
    });

    const txHash = await ethUtils.submitTransaction(signedTx);
    const receipt = await ethUtils.waitForConfirmation(txHash);

    // =====================================================
    // STEP 7: CLAIM DEPOSIT
    // =====================================================

    console.log("\n📍 Step 7: Claiming deposit...");

    const readEvent = (await eventPromises.readRespond) as any;
    console.log("  ✅ Got read response!");

    const claimTx = await program.methods
      .claimErc20(
        requestIdBytes as any,
        Buffer.from(readEvent.serializedOutput),
        readEvent.signature,
        null
      )
      .accounts({
        userBalance: accounts.userBalance,
      })
      .rpc();

    console.log("  ✅ Claim transaction:", claimTx);

    // =====================================================
    // STEP 8: VERIFY BALANCE
    // =====================================================

    console.log("\n📍 Step 8: Verifying balance...");

    const finalBalance = await program.account.userErc20Balance.fetch(
      accounts.userBalance
    );
    const expectedBalance = initialBalance.add(amountBN);

    console.log("  💰 Initial balance:", initialBalance.toString());
    console.log("  ➕ Amount deposited:", amountBN.toString());
    console.log("  💰 Final balance:", finalBalance.amount.toString());
    console.log("  ✅ Expected balance:", expectedBalance.toString());

    expect(finalBalance.amount.toString()).to.equal(expectedBalance.toString());

    // Cleanup
    await cleanupEventListeners(eventPromises);

    console.log("\n🎉 ERC20 deposit flow completed successfully!");
  });

  it("Should complete full ERC20 withdraw flow", async function () {
    console.log("\n🚀 Starting ERC20 Withdraw Flow Test\n");

    // =====================================================
    // STEP 1: CHECK BALANCE
    // =====================================================

    console.log("📍 Step 1: Checking current balance...");

    const erc20AddressBytes = Array.from(
      Buffer.from(CONFIG.USDC_ADDRESS_SEPOLIA.slice(2), "hex")
    );

    const [userBalance] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_erc20_balance"),
        provider.wallet.publicKey.toBuffer(),
        Buffer.from(erc20AddressBytes),
      ],
      program.programId
    );

    const currentBalance = await program.account.userErc20Balance.fetch(
      userBalance
    );
    console.log("  💰 Current balance:", currentBalance.amount.toString());

    // =====================================================
    // STEP 2: DERIVE RECIPIENT ADDRESS
    // =====================================================

    console.log("\n📍 Step 2: Deriving recipient address...");

    const [vaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    const [globalVaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_vault_authority")],
      program.programId
    );

    // Use the SOLANA address as path, just like in deposit!
    const path = provider.wallet.publicKey.toString();
    const derivedPublicKey = CryptoUtils.derivePublicKey(
      path,
      vaultAuthority.toString(),
      CONFIG.BASE_PUBLIC_KEY
    );
    const recipientAddress = ethers.computeAddress(derivedPublicKey);
    const recipientAddressBytes = Array.from(
      Buffer.from(recipientAddress.slice(2), "hex")
    );

    console.log("  👛 Solana wallet:", provider.wallet.publicKey.toString());
    console.log("  📂 Path (Solana address):", path);
    console.log("  🎯 Recipient address:", recipientAddress);

    // =====================================================
    // STEP 3: PREPARE WITHDRAWAL TRANSACTION
    // =====================================================

    console.log("\n📍 Step 3: Preparing withdrawal transaction...");

    // Withdraw the full balance
    const withdrawAmount = currentBalance.amount.div(new anchor.BN(2));
    const withdrawAmountBigInt = BigInt(withdrawAmount.toString());

    // Get nonce for HARDCODED_RECIPIENT
    const ethprovider = ethUtils.getProvider();
    const nonce = await ethprovider.getTransactionCount(
      CONFIG.HARDCODED_RECIPIENT
    );
    console.log("  📊 Nonce for hardcoded recipient:", nonce);

    // Build withdrawal transaction
    const transferInterface = new ethers.Interface([
      "function transfer(address to, uint256 amount) returns (bool)",
    ]);
    const callData = transferInterface.encodeFunctionData("transfer", [
      recipientAddress,
      withdrawAmountBigInt,
    ]);

    // Get gas prices
    const feeData = await ethprovider.getFeeData();
    const maxFeePerGas =
      feeData.maxFeePerGas || ethers.parseUnits("30", "gwei");
    const maxPriorityFeePerGas =
      feeData.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei");

    // Estimate gas
    const gasEstimate = await ethprovider.estimateGas({
      from: CONFIG.HARDCODED_RECIPIENT,
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      data: callData,
    });

    const gasLimit =
      (gasEstimate * BigInt(100 + CONFIG.GAS_BUFFER_PERCENT)) / BigInt(100);

    const txParams: TransactionParams = {
      nonce: new anchor.BN(nonce),
      value: new anchor.BN(0),
      maxPriorityFeePerGas: new anchor.BN(maxPriorityFeePerGas.toString()),
      maxFeePerGas: new anchor.BN(maxFeePerGas.toString()),
      gasLimit: new anchor.BN(gasLimit.toString()),
      chainId: new anchor.BN(CONFIG.SEPOLIA_CHAIN_ID),
    };

    // Build RLP-encoded transaction
    const tempTx = {
      type: 2,
      chainId: CONFIG.SEPOLIA_CHAIN_ID,
      nonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit,
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      value: BigInt(0),
      data: callData,
    };

    const rlpEncodedTx = ethers.Transaction.from(tempTx).unsignedSerialized;

    // Generate request ID - using HARDCODED_ROOT_PATH
    const requestId = CryptoUtils.generateSignBidirectionalRequestId(
      globalVaultAuthority.toString(),
      Array.from(ethers.getBytes(rlpEncodedTx)),
      CONFIG.ETHEREUM_CAIP2_ID,
      0,
      "root", // HARDCODED_ROOT_PATH
      "ECDSA",
      "ethereum",
      ""
    );
    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), "hex"));

    // =====================================================
    // STEP 4: SETUP EVENT LISTENERS
    // =====================================================

    console.log("\n📍 Step 4: Setting up event listeners...");

    const eventPromises = await setupEventListeners(
      provider,
      requestId,
      CONFIG.HARDCODED_RECIPIENT,
      rlpEncodedTx
    );

    // =====================================================
    // STEP 5: INITIATE WITHDRAWAL
    // =====================================================

    console.log("\n📍 Step 5: Initiating withdrawal...");

    const withdrawTx = await program.methods
      .withdrawErc20(
        requestIdBytes as any,
        erc20AddressBytes as any,
        withdrawAmount,
        recipientAddressBytes as any,
        txParams
      )
      .accounts({
        authority: provider.wallet.publicKey,
        feePayer: provider.wallet.publicKey,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();

    console.log("  ✅ Withdrawal transaction:", withdrawTx);

    // Check balance was decremented
    const balanceAfterWithdraw = await program.account.userErc20Balance.fetch(
      userBalance
    );
    console.log(
      "  💰 Balance after withdrawal:",
      balanceAfterWithdraw.amount.toString()
    );
    const expectedBalanceAfterWithdraw =
      currentBalance.amount.sub(withdrawAmount);
    expect(balanceAfterWithdraw.amount.toString()).to.equal(
      expectedBalanceAfterWithdraw.toString()
    );

    // =====================================================
    // STEP 6: WAIT FOR SIGNATURE
    // =====================================================

    console.log("\n📍 Step 6: Waiting for signature...");

    const signatureEvent = (await eventPromises.signature) as any;
    const signature = extractSignature(signatureEvent);

    // =====================================================
    // STEP 7: SUBMIT TO ETHEREUM
    // =====================================================

    console.log("\n📍 Step 7: Submitting to Ethereum...");

    const signedTx = ethers.Transaction.from({
      type: 2,
      chainId: CONFIG.SEPOLIA_CHAIN_ID,
      nonce,
      maxPriorityFeePerGas: BigInt(txParams.maxPriorityFeePerGas.toString()),
      maxFeePerGas: BigInt(txParams.maxFeePerGas.toString()),
      gasLimit: BigInt(txParams.gasLimit.toString()),
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      value: BigInt(0),
      data: callData,
      signature,
    });

    console.log(signedTx.from, "from address");

    const txHash = await ethUtils.submitTransaction(signedTx);
    const receipt = await ethUtils.waitForConfirmation(txHash);

    console.log("  ✅ Transaction successful!");
    console.log("  🔗 Transaction hash:", txHash);
    console.log("  📦 Block number:", receipt.blockNumber);
    console.log("  ⛽ Gas used:", receipt.gasUsed.toString());

    // =====================================================
    // STEP 8: COMPLETE WITHDRAWAL
    // =====================================================

    console.log("\n📍 Step 8: Completing withdrawal...");

    const readEvent = (await eventPromises.readRespond) as any;
    console.log("  ✅ Got read response!");

    const completeTx = await program.methods
      .completeWithdrawErc20(
        requestIdBytes as any,
        Buffer.from(readEvent.serializedOutput),
        readEvent.signature,
        null
      )
      .accounts({
        userBalance,
      })
      .rpc();

    console.log("  ✅ Complete withdrawal transaction:", completeTx);

    // Check if withdrawal was successful by checking balance
    const finalBalance = await program.account.userErc20Balance.fetch(
      userBalance
    );

    if (readEvent.serializedOutput.length === 1) {
      // Boolean response - check if transfer succeeded
      const success = readEvent.serializedOutput[0] === 1;
      if (!success) {
        console.log("  ⚠️ Transfer returned false, balance was refunded");
        expect(finalBalance.amount.toString()).to.equal(
          withdrawAmount.toString()
        );
        return;
      }
    } else {
      // Error struct response - balance should be refunded
      console.log("  ⚠️ Transaction reverted, balance was refunded");
      expect(finalBalance.amount.toString()).to.equal(
        withdrawAmount.toString()
      );
      return;
    }

    // If we get here, withdrawal should have succeeded
    const expectedBalance = currentBalance.amount.sub(withdrawAmount);
    expect(finalBalance.amount.toString()).to.equal(expectedBalance.toString());
    console.log("  ✅ Balance is now:", finalBalance.amount.toString());

    // =====================================================
    // STEP 9: VERIFY RECIPIENT BALANCE
    // =====================================================

    console.log("\n📍 Step 9: Verifying recipient received funds...");

    // Check USDC balance of recipient
    const usdcContract = new ethers.Contract(
      CONFIG.USDC_ADDRESS_SEPOLIA,
      ["function balanceOf(address) view returns (uint256)"],
      ethprovider
    );

    const recipientBalance = await usdcContract.balanceOf(recipientAddress);
    console.log(
      "  💰 Recipient USDC balance:",
      ethers.formatUnits(recipientBalance, CONFIG.DECIMALS)
    );

    // Cleanup
    await cleanupEventListeners(eventPromises);

    console.log("\n🎉 ERC20 withdrawal flow completed successfully!");
  });

  it("Should handle failed ERC20 withdrawal and refund balance", async function () {
    console.log("\n🚀 Starting Failed ERC20 Withdrawal Test\n");

    // =====================================================
    // STEP 1: CHECK EXISTING BALANCE
    // =====================================================

    console.log("📍 Step 1: Checking existing balance...");

    const erc20AddressBytes = Array.from(
      Buffer.from(CONFIG.USDC_ADDRESS_SEPOLIA.slice(2), "hex")
    );

    const [userBalance] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_erc20_balance"),
        provider.wallet.publicKey.toBuffer(),
        Buffer.from(erc20AddressBytes),
      ],
      program.programId
    );

    const currentBalance = await program.account.userErc20Balance.fetch(
      userBalance
    );
    console.log("  💰 Current balance:", currentBalance.amount.toString());

    if (currentBalance.amount.eq(new anchor.BN(0))) {
      console.log("  ⚠️ No balance to test withdrawal failure. Skipping test.");
      return;
    }

    // =====================================================
    // STEP 2: CREATE FAILING WITHDRAWAL
    // =====================================================

    console.log("\n📍 Step 2: Creating withdrawal that will fail...");

    const recipientAddress = "0x0000000000000000000000000000000000000001";
    const recipientAddressBytes = Array.from(
      Buffer.from(recipientAddress.slice(2), "hex")
    );

    const withdrawAmount = currentBalance.amount;

    // Get current nonce
    const ethprovider = ethUtils.getProvider();
    const currentNonce = await ethprovider.getTransactionCount(
      CONFIG.HARDCODED_RECIPIENT
    );
    console.log("  📊 Current nonce:", currentNonce);

    // Use an old nonce to make transaction fail
    const oldNonce = currentNonce > 0 ? currentNonce - 1 : 0;
    console.log("  📊 Using already-used nonce:", oldNonce);

    // Build withdrawal transaction with OLD nonce
    const transferInterface = new ethers.Interface([
      "function transfer(address to, uint256 amount) returns (bool)",
    ]);
    const callData = transferInterface.encodeFunctionData("transfer", [
      recipientAddress,
      withdrawAmount.toString(),
    ]);

    const feeData = await ethprovider.getFeeData();
    const maxFeePerGas =
      feeData.maxFeePerGas || ethers.parseUnits("30", "gwei");
    const maxPriorityFeePerGas =
      feeData.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei");

    const gasEstimate = 100000;

    const txParams: TransactionParams = {
      nonce: new anchor.BN(oldNonce), // OLD NONCE
      value: new anchor.BN(0),
      maxPriorityFeePerGas: new anchor.BN(maxPriorityFeePerGas.toString()),
      maxFeePerGas: new anchor.BN(maxFeePerGas.toString()),
      gasLimit: new anchor.BN(gasEstimate.toString()),
      chainId: new anchor.BN(CONFIG.SEPOLIA_CHAIN_ID),
    };

    const tempTx = {
      type: 2,
      chainId: CONFIG.SEPOLIA_CHAIN_ID,
      nonce: oldNonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit: BigInt(gasEstimate),
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      value: BigInt(0),
      data: callData,
    };

    const rlpEncodedTx = ethers.Transaction.from(tempTx).unsignedSerialized;

    const [globalVaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_vault_authority")],
      program.programId
    );

    const requestId = CryptoUtils.generateSignBidirectionalRequestId(
      globalVaultAuthority.toString(),
      Array.from(ethers.getBytes(rlpEncodedTx)),
      CONFIG.ETHEREUM_CAIP2_ID,
      0,
      "root", // HARDCODED_ROOT_PATH
      "ECDSA",
      "ethereum",
      ""
    );
    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), "hex"));

    // =====================================================
    // STEP 3: SETUP EVENT LISTENERS
    // =====================================================

    console.log("\n📍 Step 3: Setting up event listeners...");

    const eventPromises = await setupEventListeners(
      provider,
      requestId,
      CONFIG.HARDCODED_RECIPIENT,
      rlpEncodedTx
    );

    // =====================================================
    // STEP 4: INITIATE WITHDRAWAL
    // =====================================================

    console.log("\n📍 Step 4: Initiating withdrawal...");

    const balanceBeforeWithdraw = currentBalance.amount;

    const withdrawTx = await program.methods
      .withdrawErc20(
        requestIdBytes as any,
        erc20AddressBytes as any,
        withdrawAmount,
        recipientAddressBytes as any,
        txParams
      )
      .accounts({
        authority: provider.wallet.publicKey,
        feePayer: provider.wallet.publicKey,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();

    console.log("  ✅ Withdrawal transaction:", withdrawTx);

    // Check balance was decremented optimistically
    const balanceAfterWithdraw = await program.account.userErc20Balance.fetch(
      userBalance
    );
    console.log(
      "  💰 Balance after withdrawal:",
      balanceAfterWithdraw.amount.toString()
    );
    expect(balanceAfterWithdraw.amount.toString()).to.equal("0");

    // =====================================================
    // STEP 5: WAIT FOR SIGNATURE
    // =====================================================

    console.log("\n📍 Step 5: Waiting for signature...");

    const signatureEvent = (await eventPromises.signature) as any;
    const signature = extractSignature(signatureEvent);

    // =====================================================
    // STEP 6: TRY TO SUBMIT (WILL FAIL)
    // =====================================================

    console.log("\n📍 Step 6: Attempting to submit transaction...");

    const signedTx = ethers.Transaction.from({
      type: 2,
      chainId: CONFIG.SEPOLIA_CHAIN_ID,
      nonce: txParams.nonce.toNumber(),
      maxPriorityFeePerGas: BigInt(txParams.maxPriorityFeePerGas.toString()),
      maxFeePerGas: BigInt(txParams.maxFeePerGas.toString()),
      gasLimit: BigInt(txParams.gasLimit.toString()),
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      value: BigInt(0),
      data: callData,
      signature,
    });

    try {
      const txHash = await ethUtils.submitTransaction(signedTx);
      console.log("  🔗 Transaction submitted:", txHash);

      // If nonce was already used, this will fail immediately
      // If we sent a replacement tx, this will fail with "replacement transaction underpriced"
      // The server will detect the failure and send error response
      const receipt = await ethUtils.waitForConfirmation(txHash);
      console.log("  ⚠️ Transaction unexpectedly succeeded!");
    } catch (error: any) {
      console.log("  ✅ Transaction failed as expected!");
      console.log("  📊 Error:", error.message || error.shortMessage || error);
      // The server monitoring this transaction will send an error response
    }

    // =====================================================
    // STEP 7: WAIT FOR ERROR RESPONSE
    // =====================================================

    console.log("\n📍 Step 7: Waiting for error response...");

    const readEvent = (await eventPromises.readRespond) as any;
    console.log("  ✅ Got read response!");
    console.log(
      "  📊 Response length:",
      readEvent.serializedOutput.length,
      "bytes"
    );

    // =====================================================
    // STEP 8: COMPLETE WITHDRAWAL (REFUND)
    // =====================================================

    console.log("\n📍 Step 8: Completing withdrawal (expecting refund)...");

    const completeTx = await program.methods
      .completeWithdrawErc20(
        requestIdBytes as any,
        Buffer.from(readEvent.serializedOutput),
        readEvent.signature,
        null
      )
      .accounts({
        userBalance,
      })
      .rpc();

    console.log("  ✅ Complete withdrawal transaction:", completeTx);

    // =====================================================
    // STEP 9: VERIFY REFUND
    // =====================================================

    console.log("\n📍 Step 9: Verifying balance was refunded...");

    const finalBalance = await program.account.userErc20Balance.fetch(
      userBalance
    );

    console.log("  💰 Initial balance:", balanceBeforeWithdraw.toString());
    console.log("  💰 Final balance:", finalBalance.amount.toString());

    expect(finalBalance.amount.toString()).to.equal(
      balanceBeforeWithdraw.toString()
    );

    // Cleanup
    await cleanupEventListeners(eventPromises);

    console.log("\n🎉 Failed withdrawal handled correctly - balance refunded!");
  });
});

/**
 * Setup event listeners for chain signatures using signet.js
 */
async function setupEventListeners(
  provider: anchor.AnchorProvider,
  requestId: string,
  derivedAddress: string,
  rlpEncodedTx: string
) {
  let signatureResolve: (value: any) => void;
  let readRespondResolve: (value: any) => void;

  const signaturePromise = new Promise((resolve) => {
    signatureResolve = resolve;
  });

  const readRespondPromise = new Promise((resolve) => {
    readRespondResolve = resolve;
  });

  // Create signet.js ChainSignatureContract instance for event monitoring
  // Derive root public key from the private key being used
  const privateKey =
    "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const rootPublicKeyUncompressed = secp256k1.getPublicKey(
    privateKey.slice(2),
    false
  ); // Get uncompressed public key

  // Remove the 04 prefix and convert to base58
  // signet.js expects: secp256k1:{base58_of_uncompressed_key_without_04}
  const publicKeyBytes = rootPublicKeyUncompressed.slice(1); // Remove 04 prefix
  const base58PublicKey = anchor.utils.bytes.bs58.encode(publicKeyBytes);
  const rootPublicKeyForSignet = `secp256k1:${base58PublicKey}`;

  console.log(
    "  🔑 Derived root public key for signet.js:",
    rootPublicKeyForSignet
  );
  console.log(
    "  🔑 Uncompressed hex:",
    "0x" + Buffer.from(rootPublicKeyUncompressed).toString("hex")
  );

  const signetContract = new contracts.solana.ChainSignatureContract({
    provider,
    programId: new anchor.web3.PublicKey(CONFIG.CHAIN_SIGNATURES_PROGRAM_ID),
    config: {
      rootPublicKey: rootPublicKeyForSignet as `secp256k1:${string}`,
    },
  });

  // Subscribe to CPI events using signet.js
  const unsubscribe = await signetContract.subscribeToEvents({
    onSignatureResponded: (event, slot) => {
      const eventRequestId =
        "0x" + Buffer.from(event.requestId).toString("hex");
      console.log(
        `  📡 Signature event detected for request: ${eventRequestId} (slot: ${slot})`
      );

      if (eventRequestId === requestId) {
        console.log("  ✅ Signature event received! (slot:", slot, ")");

        // ADD VERIFICATION HERE
        const signature = event.signature;
        const r = "0x" + Buffer.from(signature.bigR.x).toString("hex");
        const s = "0x" + Buffer.from(signature.s).toString("hex");
        const v = BigInt(signature.recoveryId + 27);

        // Recover address from signature
        const txHash = ethers.keccak256(rlpEncodedTx);
        const recoveredAddress = ethers.recoverAddress(txHash, { r, s, v });

        // Verify it matches the derived address
        if (recoveredAddress.toLowerCase() !== derivedAddress.toLowerCase()) {
          console.error("❌ Signature verification failed!");
          console.error("  Expected:", derivedAddress);
          console.error("  Recovered:", recoveredAddress);
          throw new Error("Signature does not match derived address");
        }

        console.log("  ✅ Signature verified! Matches derived address");
        signatureResolve(event);
      }
    },
    onSignatureError: (event, slot) => {
      const eventRequestId =
        "0x" + Buffer.from(event.requestId).toString("hex");
      console.log(
        `  📡 Signature error detected for request: ${eventRequestId} (slot: ${slot})`
      );

      if (eventRequestId === requestId) {
        console.error("  ❌ Signature error event received! (slot:", slot, ")");
        console.error("  Error:", event.error);
        signatureResolve({ error: event.error });
      }
    },
  });

  // Note: signet.js only listens to NEW events, it doesn't fetch historical ones
  // Note: RespondBidirectionalEvent is not yet supported in signet.js event subscription
  // We'll need to poll for it separately or wait for signet.js update
  const program = new anchor.Program<ChainSignaturesProject>(
    IDL as any,
    provider
  );

  const readRespondListener = program.addEventListener(
    "respondBidirectionalEvent" as any,
    (event: any) => {
      const eventRequestId =
        "0x" + Buffer.from(event.requestId).toString("hex");
      if (eventRequestId === requestId) {
        console.log("  ✅ Respond bidirectional event received!");
        readRespondResolve(event);
      }
    }
  );

  return {
    signature: signaturePromise,
    readRespond: readRespondPromise,
    unsubscribe,
    readRespondListener,
  };
}

/**
 * Get deposit accounts
 */
async function getDepositAccounts(
  program: Program<SolanaCoreContracts>,
  provider: anchor.AnchorProvider,
  requestIdBytes: number[],
  erc20AddressBytes: number[]
) {
  const [pendingDeposit] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("pending_erc20_deposit"), Buffer.from(requestIdBytes)],
    program.programId
  );

  const [userBalance] = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("user_erc20_balance"),
      provider.wallet.publicKey.toBuffer(),
      Buffer.from(erc20AddressBytes),
    ],
    program.programId
  );

  const [chainSignaturesState] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("program-state")],
    new anchor.web3.PublicKey(CONFIG.CHAIN_SIGNATURES_PROGRAM_ID)
  );

  return { pendingDeposit, userBalance, chainSignaturesState };
}

/**
 * Get initial balance
 */
async function getInitialBalance(
  program: Program<SolanaCoreContracts>,
  userBalance: anchor.web3.PublicKey
): Promise<anchor.BN> {
  try {
    const account = await program.account.userErc20Balance.fetch(userBalance);
    console.log("  💰 Initial balance:", account.amount.toString());
    return account.amount;
  } catch {
    console.log("  💰 No existing balance");
    return new anchor.BN(0);
  }
}

/**
 * Extract signature from event
 */
function extractSignature(event: any) {
  const signature = event.signature;
  const r = "0x" + Buffer.from(signature.bigR.x).toString("hex");
  const s = "0x" + Buffer.from(signature.s).toString("hex");
  const v = BigInt(signature.recoveryId + 27);

  console.log("  🔏 Signature components:");
  console.log("    r:", r);
  console.log("    s:", s);
  console.log("    v:", v);

  return { r, s, v };
}

/**
 * Cleanup event listeners
 */
async function cleanupEventListeners(eventPromises: any) {
  // Unsubscribe from signet.js events
  if (eventPromises.unsubscribe) {
    await eventPromises.unsubscribe();
  }

  // Remove readRespondListener (still using Anchor for this)
  if (eventPromises.readRespondListener) {
    // The readRespondListener needs to be removed with the program instance
    // but we don't have it here, so we'll just leave it - it will be cleaned up when test ends
  }
}
