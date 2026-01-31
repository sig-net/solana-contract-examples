import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram } from "@solana/web3.js";
import BN from "bn.js";
import { SolanaCoreContracts } from "../target/types/solana_core_contracts";
import { ChainSignaturesProject } from "../types/chain_signatures_project";
import IDL from "../idl/chain_signatures_project.json";
import { expect } from "chai";
import { ethers } from "ethers";
import { contracts, utils as signetUtils } from "signet.js";
import { ChainSignatureServer, RequestIdGenerator } from "fakenet-signer";
import { CONFIG, SERVER_CONFIG } from "../utils/envConfig";

const COMPUTE_UNITS = 1_400_000;

interface TransactionParams {
  nonce: BN;
  value: BN;
  maxPriorityFeePerGas: BN;
  maxFeePerGas: BN;
  gasLimit: BN;
  chainId: BN;
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
    to: string,
    amount: bigint
  ): Promise<{
    callData: string;
    txParams: TransactionParams;
    rlpEncodedTx: string;
    nonce: number;
  }> {
    const nonce = await this.provider.getTransactionCount(from);

    const transferInterface = new ethers.Interface([
      "function transfer(address to, uint256 amount) returns (bool)",
    ]);
    const callData = transferInterface.encodeFunctionData("transfer", [
      to,
      amount,
    ]);

    const feeData = await this.provider.getFeeData();
    const maxFeePerGas =
      feeData.maxFeePerGas || ethers.parseUnits("30", "gwei");
    const maxPriorityFeePerGas =
      feeData.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei");

    const gasEstimate = await this.provider.estimateGas({
      from,
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      data: callData,
    });

    const gasLimit =
      (gasEstimate * BigInt(100 + CONFIG.GAS_BUFFER_PERCENT)) / BigInt(100);

    // Create transaction params
    const txParams: TransactionParams = {
      nonce: new BN(nonce),
      value: new BN(0),
      maxPriorityFeePerGas: new BN(maxPriorityFeePerGas.toString()),
      maxFeePerGas: new BN(maxFeePerGas.toString()),
      gasLimit: new BN(gasLimit.toString()),
      chainId: new BN(CONFIG.SEPOLIA_CHAIN_ID),
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
    const txHash = await this.provider.send("eth_sendRawTransaction", [
      signedTx.serialized,
    ]);
    return txHash;
  }

  /**
   * Wait for transaction confirmation
   */
  async waitForConfirmation(
    txHash: string
  ): Promise<ethers.TransactionReceipt> {
    const receipt = await this.provider.waitForTransaction(txHash, 1);
    if (!receipt) {
      throw new Error("Transaction receipt not found");
    }
    if (receipt.status !== 1) {
      throw new Error("Transaction failed");
    }
    return receipt;
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

  const publicKeyHex = CONFIG.MPC_ROOT_PUBLIC_KEY.startsWith("04")
    ? CONFIG.MPC_ROOT_PUBLIC_KEY.slice(2)
    : CONFIG.MPC_ROOT_PUBLIC_KEY;
  const publicKeyBytes = Array.from(Buffer.from(publicKeyHex, "hex"));

  const accountInfo = await provider.connection.getAccountInfo(vaultConfigPda);

  if (!accountInfo) {
    await program.methods
      .initializeConfig(publicKeyBytes)
      .accountsStrict({
        payer: provider.wallet.publicKey,
        config: vaultConfigPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  }
}

describe("🏦 ERC20 Deposit, Withdraw and Withdraw with refund Flow", () => {
  // Test context
  let provider: anchor.AnchorProvider;
  let program: Program<SolanaCoreContracts>;
  let ethUtils: EthereumUtils;
  let server: ChainSignatureServer | null = null;

  before(async function () {
    this.timeout(30000);

    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    program = anchor.workspace
      .SolanaCoreContracts as Program<SolanaCoreContracts>;

    await ensureVaultConfigInitialized(program, provider);

    ethUtils = new EthereumUtils();

    if (!SERVER_CONFIG.DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER) {
      const serverConfig = {
        solanaRpcUrl: SERVER_CONFIG.SOLANA_RPC_URL,
        solanaPrivateKey: SERVER_CONFIG.SOLANA_PRIVATE_KEY,
        mpcRootKey: CONFIG.MPC_ROOT_PRIVATE_KEY,
        infuraApiKey: CONFIG.INFURA_API_KEY,
        programId: CONFIG.CHAIN_SIGNATURES_PROGRAM_ID,
        isDevnet: true,
        verbose: false,
        bitcoinNetwork: CONFIG.BITCOIN_NETWORK,
      };

      server = new ChainSignatureServer(serverConfig);
      await server.start();
    } else {
      console.log("🔌 Local ChainSignatureServer disabled via config");
    }
  });

  after(async function () {
    this.timeout(10000);

    if (server) {
      await server.shutdown();
      server = null;
    }
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

    const [globalVaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_vault_authority")],
      program.programId
    );

    const path = provider.wallet.publicKey.toString();
    const derivedPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      vaultAuthority.toString(),
      path,
      CONFIG.SOLANA_CAIP2_ID,
      CONFIG.KEY_VERSION
    );
    const derivedAddress = ethers.computeAddress("0x" + derivedPublicKey);

    const signerPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      globalVaultAuthority.toString(),
      "root",
      CONFIG.SOLANA_CAIP2_ID,
      CONFIG.KEY_VERSION
    );
    const signerAddress = ethers.computeAddress("0x" + signerPublicKey);

    const mpcRespondPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      vaultAuthority.toString(),
      CONFIG.SOLANA_RESPOND_BIDIRECTIONAL_PATH,
      CONFIG.SOLANA_CAIP2_ID,
      CONFIG.KEY_VERSION
    );
    const mpcRespondAddress = ethers.computeAddress("0x" + mpcRespondPublicKey);

    console.log("  🔑 MPC Respond address:", mpcRespondAddress);
    console.log("  👛 Wallet:", provider.wallet.publicKey.toString());
    console.log(
      "  🔑 Chain Signatures Program ID:",
      CONFIG.CHAIN_SIGNATURES_PROGRAM_ID
    );
    console.log("  🔑 Derived address (FROM):", derivedAddress);
    console.log("  🎯 Signer address (TO):", signerAddress);
    console.log("  ⏳ Waiting 5 seconds...\n");
    await new Promise((resolve) =>
      setTimeout(resolve, CONFIG.WAIT_FOR_FUNDING_MS)
    );

    // =====================================================
    // STEP 2: PREPARE TRANSACTION
    // =====================================================

    console.log("📍 Step 2: Preparing transaction...");

    const amountBigInt = ethers.parseUnits(
      CONFIG.TRANSFER_AMOUNT,
      CONFIG.DECIMALS
    );
    const amountBN = new BN(amountBigInt.toString());
    const erc20AddressBytes = Array.from(
      Buffer.from(CONFIG.USDC_ADDRESS_SEPOLIA.slice(2), "hex")
    );

    const { callData, txParams, rlpEncodedTx, nonce } =
      await ethUtils.buildTransferTransaction(
        derivedAddress,
        signerAddress,
        amountBigInt
      );

    console.log("  💰 Depositing:", amountBN.toString(), "units");

    // Generate request ID
    const requestId = RequestIdGenerator.generateSignBidirectionalRequestId(
      vaultAuthority.toString(),
      Array.from(ethers.getBytes(rlpEncodedTx)),
      CONFIG.ETHEREUM_CAIP2_ID,
      CONFIG.KEY_VERSION,
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
      mpcRespondAddress,
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
      Buffer.from(signerAddress.slice(2), "hex")
    );

    const depositTx = await program.methods
      .depositErc20(
        requestIdBytes,
        provider.wallet.publicKey,
        erc20AddressBytes,
        recipientAddressBytes,
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

    const signatureEvent = await eventPromises.signature;
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
    await ethUtils.waitForConfirmation(txHash);
    console.log("  ✅ Transaction confirmed:", txHash);

    // =====================================================
    // STEP 7: CLAIM DEPOSIT
    // =====================================================

    console.log("\n📍 Step 7: Claiming deposit...");

    const respondBidirectionalEvent =
      (await eventPromises.respondBidirectional) as any;
    console.log("  ✅ Got read response!");

    const claimTx = await program.methods
      .claimErc20(
        requestIdBytes,
        Buffer.from(respondBidirectionalEvent.serializedOutput),
        respondBidirectionalEvent.signature
      )
      .accounts({
        userBalance: accounts.userBalance,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
      ])
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

    console.log("\n📍 Step 2: Deriving signer address...");

    const [globalVaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_vault_authority")],
      program.programId
    );

    const signerPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      globalVaultAuthority.toString(),
      "root",
      CONFIG.SOLANA_CAIP2_ID,
      CONFIG.KEY_VERSION
    );
    const signerAddress = ethers.computeAddress("0x" + signerPublicKey);

    const mpcRespondPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      globalVaultAuthority.toString(),
      CONFIG.SOLANA_RESPOND_BIDIRECTIONAL_PATH,
      CONFIG.SOLANA_CAIP2_ID,
      CONFIG.KEY_VERSION
    );
    const mpcRespondAddress = ethers.computeAddress("0x" + mpcRespondPublicKey);

    console.log("  🔑 MPC Respond address:", mpcRespondAddress);

    const recipientAddress = CONFIG.WITHDRAWAL_RECIPIENT_ADDRESS;
    const recipientAddressBytes = Array.from(
      Buffer.from(recipientAddress.slice(2), "hex")
    );

    console.log("  👛 Wallet:", provider.wallet.publicKey.toString());
    console.log("  🔑 MPC Signer (FROM):", signerAddress);
    console.log("  🎯 Recipient (TO):", recipientAddress);

    // =====================================================
    // STEP 3: PREPARE WITHDRAWAL TRANSACTION
    // =====================================================

    console.log("\n📍 Step 3: Preparing withdrawal transaction...");

    // Withdraw half the balance
    const withdrawAmount = currentBalance.amount.div(new BN(2));
    const withdrawAmountBigInt = BigInt(withdrawAmount.toString());

    // Get nonce for MPC signer (the transaction will be FROM this address)
    const ethprovider = ethUtils.getProvider();
    const nonce = await ethprovider.getTransactionCount(signerAddress);

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
      from: signerAddress,
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      data: callData,
    });

    const gasLimit =
      (gasEstimate * BigInt(100 + CONFIG.GAS_BUFFER_PERCENT)) / BigInt(100);

    const txParams: TransactionParams = {
      nonce: new BN(nonce),
      value: new BN(0),
      maxPriorityFeePerGas: new BN(maxPriorityFeePerGas.toString()),
      maxFeePerGas: new BN(maxFeePerGas.toString()),
      gasLimit: new BN(gasLimit.toString()),
      chainId: new BN(CONFIG.SEPOLIA_CHAIN_ID),
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
    const requestId = RequestIdGenerator.generateSignBidirectionalRequestId(
      globalVaultAuthority.toString(),
      Array.from(ethers.getBytes(rlpEncodedTx)),
      CONFIG.ETHEREUM_CAIP2_ID,
      CONFIG.KEY_VERSION,
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
      signerAddress,
      mpcRespondAddress,
      rlpEncodedTx
    );

    // =====================================================
    // STEP 5: INITIATE WITHDRAWAL
    // =====================================================

    console.log("\n📍 Step 5: Initiating withdrawal...");

    const withdrawTx = await program.methods
      .withdrawErc20(
        requestIdBytes,
        erc20AddressBytes,
        withdrawAmount,
        recipientAddressBytes,
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

    const signatureEvent = await eventPromises.signature;
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

    if (signedTx.from?.toLowerCase() !== signerAddress.toLowerCase()) {
      throw new Error(
        `Transaction from address mismatch! Expected ${signerAddress}, got ${signedTx.from}`
      );
    }

    try {
      const txHash = await ethUtils.submitTransaction(signedTx);
      await ethUtils.waitForConfirmation(txHash);
      console.log("  ✅ Transaction confirmed:", txHash);
    } catch (error: any) {
      console.error(
        "  ❌ Transaction failed:",
        error.message || error.shortMessage || error
      );
      throw error;
    }

    // =====================================================
    // STEP 8: COMPLETE WITHDRAWAL
    // =====================================================

    console.log("\n📍 Step 8: Completing withdrawal...");

    const respondBidirectionalEvent =
      (await eventPromises.respondBidirectional) as any;

    await program.methods
      .completeWithdrawErc20(
        requestIdBytes,
        Buffer.from(respondBidirectionalEvent.serializedOutput),
        respondBidirectionalEvent.signature
      )
      .accounts({
        userBalance,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
      ])
      .rpc();

    // Check if withdrawal was successful by checking balance
    const finalBalance = await program.account.userErc20Balance.fetch(
      userBalance
    );

    if (respondBidirectionalEvent.serializedOutput.length === 1) {
      const success = respondBidirectionalEvent.serializedOutput[0] === 1;
      if (!success) {
        console.log("  ⚠️ Transfer failed, balance refunded");
        expect(finalBalance.amount.toString()).to.equal(
          withdrawAmount.toString()
        );
        return;
      }
    } else {
      console.log("  ⚠️ Transaction reverted, balance refunded");
      expect(finalBalance.amount.toString()).to.equal(
        withdrawAmount.toString()
      );
      return;
    }

    const expectedBalance = currentBalance.amount.sub(withdrawAmount);
    expect(finalBalance.amount.toString()).to.equal(expectedBalance.toString());
    console.log("  ✅ Withdrawal complete");

    // =====================================================
    // STEP 9: VERIFY RECIPIENT BALANCE
    // =====================================================

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

    if (currentBalance.amount.eq(new BN(0))) {
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

    // Derive the MPC signer address first
    const [globalVaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_vault_authority")],
      program.programId
    );

    const signerPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      globalVaultAuthority.toString(),
      "root",
      CONFIG.SOLANA_CAIP2_ID,
      CONFIG.KEY_VERSION
    );
    const signerAddress = ethers.computeAddress("0x" + signerPublicKey);

    const mpcRespondPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      globalVaultAuthority.toString(),
      CONFIG.SOLANA_RESPOND_BIDIRECTIONAL_PATH,
      CONFIG.SOLANA_CAIP2_ID,
      CONFIG.KEY_VERSION
    );
    const mpcRespondAddress = ethers.computeAddress("0x" + mpcRespondPublicKey);

    // Get current nonce for MPC signer
    const ethprovider = ethUtils.getProvider();
    const currentNonce = await ethprovider.getTransactionCount(signerAddress);

    // Use an old nonce to make transaction fail
    const oldNonce = currentNonce > 0 ? currentNonce - 1 : 0;
    console.log(
      "  📊 Using old nonce:",
      oldNonce,
      "(current:",
      currentNonce + ")"
    );

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
      nonce: new BN(oldNonce), // OLD NONCE
      value: new BN(0),
      maxPriorityFeePerGas: new BN(maxPriorityFeePerGas.toString()),
      maxFeePerGas: new BN(maxFeePerGas.toString()),
      gasLimit: new BN(gasEstimate.toString()),
      chainId: new BN(CONFIG.SEPOLIA_CHAIN_ID),
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

    const requestId = RequestIdGenerator.generateSignBidirectionalRequestId(
      globalVaultAuthority.toString(),
      Array.from(ethers.getBytes(rlpEncodedTx)),
      CONFIG.ETHEREUM_CAIP2_ID,
      CONFIG.KEY_VERSION,
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
      signerAddress,
      mpcRespondAddress,
      rlpEncodedTx
    );

    // =====================================================
    // STEP 4: INITIATE WITHDRAWAL
    // =====================================================

    console.log("\n📍 Step 4: Initiating withdrawal...");

    const balanceBeforeWithdraw = currentBalance.amount;

    const withdrawTx = await program.methods
      .withdrawErc20(
        requestIdBytes,
        erc20AddressBytes,
        withdrawAmount,
        recipientAddressBytes,
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

    const signatureEvent = await eventPromises.signature;
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
      await ethUtils.waitForConfirmation(txHash);
      console.log("  ⚠️ Transaction unexpectedly succeeded!");
    } catch (error: any) {
      console.log("  ✅ Transaction failed as expected");
    }

    // =====================================================
    // STEP 7: WAIT FOR ERROR RESPONSE
    // =====================================================

    console.log("\n📍 Step 7: Waiting for error response...");

    const respondBidirectionalEvent =
      (await eventPromises.respondBidirectional) as any;

    // =====================================================
    // STEP 8: COMPLETE WITHDRAWAL (REFUND)
    // =====================================================

    console.log("\n📍 Step 8: Completing withdrawal (expecting refund)...");

    await program.methods
      .completeWithdrawErc20(
        requestIdBytes,
        Buffer.from(respondBidirectionalEvent.serializedOutput),
        respondBidirectionalEvent.signature
      )
      .accounts({
        userBalance,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
      ])
      .rpc();

    // =====================================================
    // STEP 9: VERIFY REFUND
    // =====================================================

    console.log("\n📍 Step 9: Verifying balance was refunded...");

    const finalBalance = await program.account.userErc20Balance.fetch(
      userBalance
    );

    expect(finalBalance.amount.toString()).to.equal(
      balanceBeforeWithdraw.toString()
    );

    console.log("  ✅ Balance refunded:", finalBalance.amount.toString());

    await cleanupEventListeners(eventPromises);
    console.log("\n🎉 Failed withdrawal handled correctly!");
  });
});

/**
 * Setup event listeners for chain signatures using signet.js
 */
async function setupEventListeners(
  provider: anchor.AnchorProvider,
  requestId: string,
  derivedAddress: string,
  mpcRespondAddress: string,
  rlpEncodedTx: string
) {
  let signatureResolve: (value: any) => void;
  let respondBidirectionalResolve: (value: any) => void;

  const signaturePromise = new Promise((resolve) => {
    signatureResolve = resolve;
  });

  const respondBidirectionalPromise = new Promise((resolve) => {
    respondBidirectionalResolve = resolve;
  });

  const rootPublicKeyUncompressed = Array.from(
    Buffer.from(CONFIG.MPC_ROOT_PUBLIC_KEY.slice(2), "hex")
  );

  console.log(" 🔑 Root public key:", rootPublicKeyUncompressed);

  // Remove the 04 prefix and convert to base58
  // signet.js expects: secp256k1:{base58_of_uncompressed_key_without_04}
  const publicKeyBytes = rootPublicKeyUncompressed.slice(1); // Remove 04 prefix
  const base58PublicKey = anchor.utils.bytes.bs58.encode(publicKeyBytes);
  const rootPublicKeyForSignet = `secp256k1:${base58PublicKey}`;

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
      if (eventRequestId === requestId) {
        console.log("  ✅ Signature received (slot:", slot, ")");

        // Verify signature
        const signature = event.signature;
        const r = "0x" + Buffer.from(signature.bigR.x).toString("hex");
        const s = "0x" + Buffer.from(signature.s).toString("hex");
        const v = BigInt(signature.recoveryId + 27);

        const txHash = ethers.keccak256(rlpEncodedTx);
        const recoveredAddress = ethers.recoverAddress(txHash, { r, s, v });

        if (recoveredAddress.toLowerCase() !== derivedAddress.toLowerCase()) {
          console.error("❌ Signature verification failed!");
          console.error("  Expected:", derivedAddress);
          console.error("  Recovered:", recoveredAddress);
          throw new Error("Signature does not match derived address");
        }

        signatureResolve(event);
      }
    },
    onSignatureError: (event, slot) => {
      const eventRequestId =
        "0x" + Buffer.from(event.requestId).toString("hex");

      if (eventRequestId === requestId) {
        console.error("  ❌ Signature error (slot:", slot, "):", event.error);
        signatureResolve({ error: event.error });
      }
    },
  });

  const program = new anchor.Program<ChainSignaturesProject>(IDL, provider);

  const respondBidirectionalListener = program.addEventListener(
    "respondBidirectionalEvent" as any,
    (event: any) => {
      const eventRequestId =
        "0x" + Buffer.from(event.requestId).toString("hex");
      if (eventRequestId === requestId) {
        console.log("  ✅ Respond bidirectional event received!");
        // Verify signature
        // Recover address from signature
        const msgHash = hash_message(
          eventRequestId as any,
          event.serializedOutput
        );
        console.log(" 🔏 Message hash:", msgHash);
        const signature = event.signature;
        const r = "0x" + Buffer.from(signature.bigR.x).toString("hex");
        const s = "0x" + Buffer.from(signature.s).toString("hex");
        const v = BigInt(signature.recoveryId + 27);
        // Recover address from signature
        const recoveredAddress = ethers.recoverAddress(msgHash, { r, s, v });

        // Verify it matches the derived address
        if (
          recoveredAddress.toLowerCase() !== mpcRespondAddress.toLowerCase()
        ) {
          console.error("❌ read respond signature verification failed!");
          console.error("  Expected:", mpcRespondAddress);
          console.error("  Recovered:", recoveredAddress);
          throw new Error(
            "read respond signature does not match mpc respond address"
          );
        }
        respondBidirectionalResolve(event);
      }
    }
  );

  return {
    signature: signaturePromise,
    respondBidirectional: respondBidirectionalPromise,
    unsubscribe,
    respondBidirectionalListener,
    program,
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
): Promise<BN> {
  try {
    const account = await program.account.userErc20Balance.fetch(userBalance);
    console.log("  💰 Initial balance:", account.amount.toString());
    return account.amount as BN;
  } catch {
    console.log("  💰 No existing balance");
    return new BN(0);
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

  return { r, s, v };
}

async function cleanupEventListeners(eventPromises: any) {
  if (eventPromises.unsubscribe) {
    await eventPromises.unsubscribe();
  }
  if (eventPromises.respondBidirectionalListener && eventPromises.program) {
    await eventPromises.program.removeEventListener(
      eventPromises.respondBidirectionalListener
    );
  }
}

function hash_message(request_id: Uint8Array, serialized_output: Uint8Array) {
  return ethers.keccak256(ethers.concat([request_id, serialized_output])); // 0x-prefixed hex
}
