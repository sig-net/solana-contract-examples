import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import {
  applySignaturesToPsbt,
  buildDepositPlan,
  buildSignatureMap,
  buildWithdrawalPlan,
  cleanupEventListeners,
  computeSignatureRequestIds,
  createFundedAuthority,
  executeSyntheticDeposit,
  extractSignatures,
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
    const { provider, program, btcUtils, bitcoinAdapter } =
      getBitcoinTestContext();

    const singleRequester = anchor.web3.Keypair.generate();
    const plan = await buildDepositPlan({
      mode: "live_single",
      requester: singleRequester.publicKey,
      amount: 5_000,
      fee: 200,
    });

    const [userBalancePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user_btc_balance"), singleRequester.publicKey.toBuffer()],
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

    const signatureRequestIds = computeSignatureRequestIds(plan);
    const events = await setupEventListeners(
      provider,
      signatureRequestIds,
      plan.requestIdHex
    );

    try {
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

      applySignaturesToPsbt(
        psbt,
        signatureMap,
        computeSignatureRequestIds(plan),
        plan.vaultAuthority.compressedPubkey
      );

      const signedTx = psbt.extractTransaction();
      await bitcoinAdapter.broadcastTransaction(signedTx.toHex());

      if (bitcoinAdapter.mineBlocks) {
        await bitcoinAdapter.mineBlocks(1);
      }

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
    } finally {
      await cleanupEventListeners(events);
    }
  });

  it("processes a multi-input BTC deposit and only credits vault-directed value", async function () {
    const { provider, program, btcUtils, bitcoinAdapter } =
      getBitcoinTestContext();

    // Use a dedicated requester (separate from the fee payer) to exercise the
    // path where vault authority is derived from a non-provider keypair.
    // This keeps coverage for “requester != fee payer” and prevents overlap
    // with the single-input test that uses the provider wallet.
    const secondaryRequester = anchor.web3.Keypair.generate();
    const plan = await buildDepositPlan({
      mode: "live_multi",
      requester: secondaryRequester,
    });

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

      applySignaturesToPsbt(
        psbt,
        signatureMap,
        computeSignatureRequestIds(plan),
        plan.vaultAuthority.compressedPubkey
      );

      const signedTx = psbt.extractTransaction();
      await bitcoinAdapter.broadcastTransaction(signedTx.toHex());

      if (bitcoinAdapter.mineBlocks) {
        await bitcoinAdapter.mineBlocks(1);
      }

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
    } finally {
      await cleanupEventListeners(events);
    }
  });

  it("processes a BTC withdrawal end-to-end", async function () {
    const { provider, program, btcUtils, bitcoinAdapter } =
      getBitcoinTestContext();

    const depositor = await createFundedAuthority();
    await executeSyntheticDeposit(7_500, depositor.publicKey);

    const feeBudget = WITHDRAW_FEE_BUDGET;

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

    const balanceAfterInitiationAccount =
      await program.account.userBtcBalance.fetch(userBalancePda);
    const balanceAfterInitiation = balanceAfterInitiationAccount.amount as BN;
    const totalDebitBn = plan.amount.add(plan.fee);
    const expectedAfterInitiation = startingBalance.sub(totalDebitBn);
    expect(balanceAfterInitiation.toString()).to.equal(
      expectedAfterInitiation.toString()
    );

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

    await bitcoinAdapter.broadcastTransaction(withdrawTxHex);

    if (bitcoinAdapter.mineBlocks) {
      await bitcoinAdapter.mineBlocks(1);
    }

    const readEvent = await events.readRespond;

    const completeTx = await program.methods
      .completeWithdrawBtc(
        planRequestIdBytes(plan),
        Buffer.from(readEvent.serializedOutput),
        readEvent.signature,
        null
      )
      .rpc();
    await provider.connection.confirmTransaction(completeTx);

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
  });
});
