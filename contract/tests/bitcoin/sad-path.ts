import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { expect } from "chai";
import BN from "bn.js";
import {
  buildDepositPlan,
  buildWithdrawalPlan,
  computeMessageHash,
  COMPUTE_UNITS,
  expectAnchorError,
  executeSyntheticDeposit,
  fetchUserBalance,
  getBitcoinTestContext,
  planRequestIdBytes,
  setupBitcoinTestContext,
  signHashWithMpcForDeposit,
  signHashWithMpcForWithdrawal,
  teardownBitcoinTestContext,
  createFundedAuthority,
} from "./utils";

describe("BTC Sad Path", () => {
  before(async function () {
    await setupBitcoinTestContext();
  });

  after(async function () {
    await teardownBitcoinTestContext();
  });

  it("rejects deposits when request ID mismatches transaction data", async function () {
    const { provider, program } = getBitcoinTestContext();
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
    const { provider, program } = getBitcoinTestContext();
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
    const { provider, program } = getBitcoinTestContext();
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
    const validSignature = await signHashWithMpcForDeposit(messageHash, plan.requester);
    const invalidSignature = JSON.parse(
      JSON.stringify(validSignature)
    ) as typeof validSignature;
    invalidSignature.s[0] ^= 0xff;

    await expectAnchorError(
      program.methods
        .claimBtc(
          planRequestIdBytes(plan),
          serializedOutput,
          invalidSignature,
          null
        )
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
        ])
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
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
      ])
      .rpc();
    await provider.connection.confirmTransaction(claimTx);
  });

  it("rejects claims when serialized outputs cannot be decoded", async function () {
    const { provider, program } = getBitcoinTestContext();
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
    const malformedSignature = await signHashWithMpcForDeposit(
      computeMessageHash(planRequestIdBytes(plan), malformedOutput),
      plan.requester
    );

    await expectAnchorError(
      program.methods
        .claimBtc(
          planRequestIdBytes(plan),
          malformedOutput,
          malformedSignature,
          null
        )
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
        ])
        .rpc(),
      /Invalid output format/
    );
  });

  it("refunds deposits when MPC output indicates transfer failure", async function () {
    const { provider, program } = getBitcoinTestContext();
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
    const failedSig = await signHashWithMpcForDeposit(
      computeMessageHash(planRequestIdBytes(plan), failedOutput),
      plan.requester
    );

    await expectAnchorError(
      program.methods
        .claimBtc(
          planRequestIdBytes(plan),
          failedOutput,
          failedSig,
          null
        )
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
        ])
        .rpc(),
      /Transfer failed/
    );
  });

  it("rejects withdrawals when provided inputs do not cover the requested debit", async function () {
    const { provider, program } = getBitcoinTestContext();
    const authority = await createFundedAuthority();
    await executeSyntheticDeposit(6_000, authority.publicKey);

    const withdrawPlan = await buildWithdrawalPlan({
      mode: "mock",
      amount: 1_500,
      fee: 25,
      inputValue: 2_000,
    });

    if (!withdrawPlan.btcInputs.length) {
      throw new Error("Mock withdrawal plan should include at least one input");
    }
    withdrawPlan.btcInputs = [
      {
        ...withdrawPlan.btcInputs[0],
        value: new BN(500),
      },
      ...withdrawPlan.btcInputs.slice(1),
    ];

    await expectAnchorError(
      program.methods
        .withdrawBtc(
          planRequestIdBytes(withdrawPlan),
          withdrawPlan.btcInputs,
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
    const { provider, program } = getBitcoinTestContext();
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
          withdrawPlan.btcInputs,
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
    const { provider, program } = getBitcoinTestContext();
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
        withdrawPlan.btcInputs,
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
    const refundSignature = await signHashWithMpcForWithdrawal(
      computeMessageHash(planRequestIdBytes(withdrawPlan), serializedOutput)
    );

    const completeTx = await program.methods
      .completeWithdrawBtc(
        planRequestIdBytes(withdrawPlan),
        serializedOutput,
        refundSignature,
        null
      )
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
      ])
      .rpc();
    await provider.connection.confirmTransaction(completeTx);

    const { amount: balanceAfter } = await fetchUserBalance(
      provider.wallet.publicKey
    );

    expect(balanceAfter.toString()).to.equal(balanceBefore.toString());
  });
});
