import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram } from "@solana/web3.js";
import BN from "bn.js";
import { expect } from "chai";
import {
  applySignaturesToPsbt,
  buildDepositPlan,
  buildDepositPsbt,
  buildSignatureMap,
  buildWithdrawalPlan,
  buildWithdrawalPsbt,
  cleanupEventListeners,
  computeSignatureRequestIds,
  COMPUTE_UNITS,
  createFundedAuthority,
  deriveUserBalancePda,
  executeSyntheticDeposit,
  extractSignature,
  fetchUserBalance,
  getBitcoinTestContext,
  planRequestIdBytes,
  prepareSignatureWitness,
  setupBitcoinTestContext,
  setupEventListeners,
  teardownBitcoinTestContext,
  WITHDRAW_FEE_BUDGET,
} from "./utils";

describe("BTC Happy Path", () => {
  before(async function () {
    await setupBitcoinTestContext();
  });

  after(async function () {
    await teardownBitcoinTestContext();
  });

  it("processes a single-input BTC deposit end-to-end", async function () {
    const { provider, program, bitcoinAdapter } = getBitcoinTestContext();

    const singleRequester = anchor.web3.Keypair.generate();
    const plan = await buildDepositPlan({
      mode: "live_single",
      requester: singleRequester.publicKey,
      amount: 5_000,
      fee: 200,
    });

    console.log("\n" + "=".repeat(60));
    console.log("🚀 [btc] Single-input deposit flow");
    console.log("=".repeat(60));
    console.log("📍 Step 1: Plan ready");
    console.log("  • requester:", singleRequester.publicKey.toString());
    console.log("  • vault address:", plan.vaultAuthority.address);
    console.log("  • global vault:", plan.globalVault.address);
    console.log("  • amount:", plan.creditedAmount.toString());
    console.log("  • inputs:", plan.btcInputs.length);
    console.log("  • outputs:", plan.btcOutputs.length);

    const userBalancePda = deriveUserBalancePda(singleRequester.publicKey);
    const { amount: initialBalance } = await fetchUserBalance(
      singleRequester.publicKey
    );

    const signatureRequestIds = computeSignatureRequestIds(plan);
    const events = await setupEventListeners(
      provider,
      signatureRequestIds,
      plan.requestIdHex
    );

    try {
      console.log("📍 Step 2: Submitting deposit ix");
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

      console.log("  • solana deposit tx:", depositTx);
      console.log("📍 Step 3: Waiting for signature response(s)");
      const signatureEvents = await events.waitForSignatures(
        plan.btcInputs.length
      );
      const signatureMap = buildSignatureMap(
        signatureEvents,
        computeSignatureRequestIds(plan)
      );

      console.log("📍 Step 4: Building/signing PSBT");
      const psbt = buildDepositPsbt(plan);

      applySignaturesToPsbt(
        psbt,
        signatureMap,
        computeSignatureRequestIds(plan),
        plan.vaultAuthority.compressedPubkey
      );

      const signedTx = psbt.extractTransaction();
      console.log("  • bitcoin txid:", signedTx.getId());
      await bitcoinAdapter.broadcastTransaction(signedTx.toHex());

      console.log("📍 Step 5: Waiting for read/claim response");
      const readEvent = await events.readRespond;

      console.log("📍 Step 6: Submitting claim ix");
      const claimTx = await program.methods
        .claimBtc(
          planRequestIdBytes(plan),
          Buffer.from(readEvent.serializedOutput),
          readEvent.signature
        )
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
        ])
        .rpc();
      await provider.connection.confirmTransaction(claimTx);

      const finalBalanceAccount = await program.account.userBtcBalance.fetch(
        userBalancePda
      );
      const expectedBalance = initialBalance.add(plan.creditedAmount);
      expect(finalBalanceAccount.amount.toString()).to.equal(
        expectedBalance.toString()
      );
      console.log("📍 Step 7: Balance verified");
    } finally {
      await cleanupEventListeners(events);
    }
  });

  it("processes a multi-input BTC deposit and only credits vault-directed value", async function () {
    const { provider, program, bitcoinAdapter } = getBitcoinTestContext();

    const secondaryRequester = anchor.web3.Keypair.generate();
    const plan = await buildDepositPlan({
      mode: "live_multi",
      requester: secondaryRequester,
    });

    console.log("\n" + "=".repeat(60));
    console.log("🚀 [btc] Multi-input deposit flow");
    console.log("=".repeat(60));
    console.log("📍 Step 1: Plan ready");
    console.log("  • requester:", secondaryRequester.publicKey.toString());
    console.log("  • vault address:", plan.vaultAuthority.address);
    console.log("  • global vault:", plan.globalVault.address);
    console.log("  • inputs:", plan.btcInputs.length);
    console.log("  • outputs:", plan.btcOutputs.length);

    const signatureRequestIds = computeSignatureRequestIds(plan);
    const events = await setupEventListeners(
      provider,
      signatureRequestIds,
      plan.requestIdHex
    );

    const userBalancePda = deriveUserBalancePda(secondaryRequester.publicKey);
    const { amount: initialBalance } = await fetchUserBalance(
      secondaryRequester.publicKey
    );

    try {
      console.log("📍 Step 2: Submitting deposit ix");
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

      console.log("  • solana deposit tx:", depositTx);
      console.log("📍 Step 3: Waiting for signature response(s)");
      const signatureEvents = await events.waitForSignatures(
        plan.btcInputs.length
      );
      const signatureMap = buildSignatureMap(
        signatureEvents,
        computeSignatureRequestIds(plan)
      );

      const psbt = buildDepositPsbt(plan);

      applySignaturesToPsbt(
        psbt,
        signatureMap,
        computeSignatureRequestIds(plan),
        plan.vaultAuthority.compressedPubkey
      );

      const signedTx = psbt.extractTransaction();
      console.log("  • bitcoin txid:", signedTx.getId());
      await bitcoinAdapter.broadcastTransaction(signedTx.toHex());

      const readEvent = await events.readRespond;

      const claimTx = await program.methods
        .claimBtc(
          planRequestIdBytes(plan),
          Buffer.from(readEvent.serializedOutput),
          readEvent.signature
        )
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
        ])
        .rpc();
      await provider.connection.confirmTransaction(claimTx);

      const finalBalanceAccount = await program.account.userBtcBalance.fetch(
        userBalancePda
      );
      const expectedBalance = initialBalance.add(plan.creditedAmount);
      expect(finalBalanceAccount.amount.toString()).to.equal(
        expectedBalance.toString()
      );
    } finally {
      await cleanupEventListeners(events);
    }
  });

  it("processes a BTC withdrawal end-to-end", async function () {
    const { provider, program, bitcoinAdapter } = getBitcoinTestContext();

    const depositor = await createFundedAuthority();
    await executeSyntheticDeposit(7_500, depositor.publicKey);

    const feeBudget = WITHDRAW_FEE_BUDGET;

    const userBalancePda = deriveUserBalancePda(depositor.publicKey);
    const { amount: startingBalance } = await fetchUserBalance(
      depositor.publicKey
    );

    if (startingBalance.lte(new BN(0))) {
      throw new Error("❌ No BTC balance available for withdrawal");
    }

    const plan = await buildWithdrawalPlan({
      mode: "live",
      authority: depositor,
      feeBudget,
    });

    console.log("\n🚀 [btc] Starting withdrawal flow");
    console.log("\n" + "=".repeat(60));
    console.log("🚀 [btc] Withdrawal flow");
    console.log("=".repeat(60));
    console.log("📍 Step 1: Plan ready");
    console.log("  • requester:", depositor.publicKey.toString());
    console.log("  • inputs:", plan.btcInputs.length);
    console.log("  • amount:", plan.amount.toString());
    console.log("  • fee:", plan.fee.toString());
    console.log("  • recipient:", plan.recipient.address);

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

    console.log("📍 Step 2: Submitting withdraw ix");
    const withdrawTx = await program.methods
      .withdrawBtc(
        planRequestIdBytes(plan),
        plan.btcInputs,
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

    const balanceAfterInitiationAccount =
      await program.account.userBtcBalance.fetch(userBalancePda);
    const balanceAfterInitiation = balanceAfterInitiationAccount.amount as BN;
    const totalDebitBn = plan.amount.add(plan.fee);
    const expectedAfterInitiation = startingBalance.sub(totalDebitBn);
    expect(balanceAfterInitiation.toString()).to.equal(
      expectedAfterInitiation.toString()
    );

    console.log("  • solana withdraw tx:", withdrawTx);
    console.log("📍 Step 3: Waiting for signature response(s)");
    const signatureEvents = await events.waitForSignatures(
      plan.selectedUtxos.length
    );
    const signatures = signatureEvents.map(extractSignature);
    if (signatures.length !== plan.selectedUtxos.length) {
      throw new Error(
        `Expected ${plan.selectedUtxos.length} signature(s), received ${signatures.length}`
      );
    }

    const withdrawPsbt = buildWithdrawalPsbt(plan);

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

    console.log("📍 Step 4: Broadcasting signed Bitcoin withdrawal");
    console.log("  • bitcoin txid:", signedWithdrawTx.getId());
    await bitcoinAdapter.broadcastTransaction(withdrawTxHex);

    const readEvent = await events.readRespond;

    console.log("📍 Step 5: Completing withdrawal on Solana");
    const completeTx = await program.methods
      .completeWithdrawBtc(
        planRequestIdBytes(plan),
        Buffer.from(readEvent.serializedOutput),
        readEvent.signature
      )
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
      ])
      .rpc();
    await provider.connection.confirmTransaction(completeTx);
    console.log("  • solana complete withdraw tx:", completeTx);

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
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect(latestRecipientBalance).to.be.at.least(expectedRecipientBalance);

    const finalBalanceAccount = await program.account.userBtcBalance.fetch(
      userBalancePda
    );
    expect(finalBalanceAccount.amount.toString()).to.equal(
      balanceAfterInitiation.toString()
    );
    console.log("📍 Step 6: Withdrawal balance checks passed");
  });
});
