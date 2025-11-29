import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import * as bitcoin from "bitcoinjs-lib";
import ECPairFactory from "ecpair";
import * as ecc from "tiny-secp256k1";
import { CryptoUtils } from "fakenet-signer";
import BN from "bn.js";
import {
  applySignaturesToPsbt,
  buildDepositPlan,
  buildSignatureMap,
  computeSignatureRequestIds,
  getBitcoinTestContext,
  planRequestIdBytes,
  setupBitcoinTestContext,
  setupEventListeners,
  teardownBitcoinTestContext,
  cleanupEventListeners,
} from "./utils";
import { CONFIG } from "../../utils/envConfig";

const ECPair = ECPairFactory(ecc);

const bnToBigInt = (value: BN | number | bigint): bigint =>
  BN.isBN(value) ? BigInt(value.toString()) : BigInt(value);

describe("BTC Prevout Conflict", () => {
  before(async function () {
    await setupBitcoinTestContext();
  });

  after(async function () {
    await teardownBitcoinTestContext();
  });

  it("emits an error respond_bidirectional when a monitored prevout is double-spent", async function () {
    this.timeout(120_000);

    const { provider, program, btcUtils, bitcoinAdapter, server } =
      getBitcoinTestContext();

    if (CONFIG.BITCOIN_NETWORK !== "regtest") {
      this.skip();
    }
    if (!CONFIG.MPC_ROOT_KEY) {
      this.skip();
    }
    if (!bitcoinAdapter.mineBlocks) {
      this.skip();
    }
    if (!server) {
      this.skip();
    }

    const requester = anchor.web3.Keypair.generate();
    const plan = await buildDepositPlan({
      mode: "live_single",
      requester: requester.publicKey,
      amount: 5_000,
      fee: 200,
    });

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
        signatureRequestIds
      );

      // Build the intended deposit transaction but do not broadcast it.
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
        signatureRequestIds,
        plan.vaultAuthority.compressedPubkey
      );
      const signedDepositTx = psbt.extractTransaction();
      const monitoredTxid = signedDepositTx.getId();

      // Craft a conflicting spend of the same prevout and mine it.
      const conflictingInput = plan.btcInputs[0];
      const inputValue = bnToBigInt(conflictingInput.value);
      const conflictFee = BigInt(500);
      const conflictOutputValue = inputValue - conflictFee;
      if (conflictOutputValue <= BigInt(0)) {
        throw new Error("Input value too small for conflict spend");
      }

      const derivedKeyHex = await CryptoUtils.deriveSigningKey(
        plan.path,
        plan.vaultAuthority.pda.toString(),
        CONFIG.MPC_ROOT_KEY
      );
      const spendingKey = ECPair.fromPrivateKey(
        Buffer.from(derivedKeyHex.slice(2), "hex"),
        { network: bitcoin.networks.regtest }
      );
      const externalKey = ECPair.makeRandom({
        network: bitcoin.networks.regtest,
      });
      const externalAddress = bitcoin.payments.p2wpkh({
        pubkey: externalKey.publicKey,
        network: bitcoin.networks.regtest,
      }).address;
      if (!externalAddress) {
        throw new Error("Failed to derive external address");
      }

      const conflictingPsbt = new bitcoin.Psbt({
        network: bitcoin.networks.regtest,
      });
      conflictingPsbt.addInput({
        hash: Buffer.from(conflictingInput.txid).toString("hex"),
        index: conflictingInput.vout,
        witnessUtxo: {
          script: Buffer.from(plan.vaultAuthority.script),
          value: inputValue,
        },
      });
      conflictingPsbt.addOutput({
        address: externalAddress,
        value: conflictOutputValue,
      });
      conflictingPsbt.signInput(0, spendingKey);
      conflictingPsbt.finalizeAllInputs();

      const conflictingTx = conflictingPsbt.extractTransaction();
      const conflictingTxHex = conflictingTx.toHex();
      const conflictingTxid = conflictingTx.getId();

      await bitcoinAdapter.broadcastTransaction(conflictingTxHex);
      await bitcoinAdapter.mineBlocks?.(1);

      const readEvent = (await Promise.race([
        events.readRespond,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "Timed out waiting for respond_bidirectional conflict payload"
                )
              ),
            90_000
          )
        ),
      ])) as Awaited<typeof events.readRespond>;

      const serializedOutput = Buffer.from(readEvent.serializedOutput);
      expect(serializedOutput.slice(0, 4).toString("hex")).to.equal("deadbeef");
      expect(serializedOutput[4]).to.equal(1);
      const respondRequestId = `0x${Buffer.from(readEvent.requestId).toString(
        "hex"
      )}`.toLowerCase();
      expect(respondRequestId).to.equal(plan.requestIdHex.toLowerCase());

      console.log("  • monitored txid:", monitoredTxid);
      console.log("  • conflicting txid:", conflictingTxid);
    } finally {
      await cleanupEventListeners(events);
    }
  });
});
