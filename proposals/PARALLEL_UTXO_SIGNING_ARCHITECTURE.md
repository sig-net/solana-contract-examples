# Parallel UTXO Signing Architecture

> **Status:** Proposal  
> **Last Updated:** 2024

---

## Problem

Solana transactions are limited to ~1232 bytes. Bitcoin transaction data scales roughly linearly with inputs, so sending full Bitcoin transaction/PSBT data through Solana quickly hits limits (~3–5 inputs).

**Goal:** Enable unlimited UTXO inputs for vault consolidation and large withdrawals by signing inputs in parallel across multiple Solana transactions.

---

## Solution

Leverage BIP143’s SegWit v0 sighash structure to sign each input independently in separate Solana transactions, while all signatures still commit to the same Bitcoin inputs + outputs.

**Key insight:** In BIP143 with `SIGHASH_ALL`, the sighash preimage contains three transaction-wide 32-byte commitments that are constant for all inputs:

- `hashPrevouts` (commits to all input outpoints)
- `hashSequence` (commits to all input sequences)
- `hashOutputs` (commits to all outputs)

Instead of passing a full PSBT, pass only these commitments + per-input fields.

---

## Scope / assumptions

- **Bitcoin inputs:** SegWit v0 spends using **BIP143** and **ECDSA** signatures with `SIGHASH_ALL` (e.g., P2WPKH / P2WSH / nested SegWit).
- **Outputs:** Recommended shape is **2 outputs**: recipient + vault change (fits typical Solana size constraints).
- **MPC signing request:** MPC receives **serialized per-input signing data** (not a precomputed digest) and constructs the BIP143 preimage deterministically.
- **Accounting cap:** The DEX uses the user’s on-chain balance as the cap for how much **input value** (sum of signed input `amount_sats`) can be authorized in a session. This implicitly bounds fees too.

---

## BIP143 sighash preimage (per input)

For each input `i`, the sighash preimage is:

```text
┌────┬────────────────┬──────────┬─────────────────────────────────┐
│ #  │ Field          │ Size     │ Scope                           │
├────┼────────────────┼──────────┼─────────────────────────────────┤
│ 1  │ nVersion       │ 4 bytes  │ Constant (tx-wide)              │
│ 2  │ hashPrevouts   │ 32 bytes │ Constant (all inputs)           │
│ 3  │ hashSequence   │ 32 bytes │ Constant (all inputs)           │
│ 4  │ outpoint       │ 36 bytes │ UNIQUE (this input's txid:vout) │
│ 5  │ scriptCode     │ var      │ UNIQUE (this input's script)    │
│ 6  │ amount         │ 8 bytes  │ UNIQUE (this input's value)     │
│ 7  │ nSequence      │ 4 bytes  │ UNIQUE (this input's sequence)  │
│ 8  │ hashOutputs    │ 32 bytes │ Constant (all outputs)          │
│ 9  │ nLockTime      │ 4 bytes  │ Constant (tx-wide)              │
│ 10 │ nHashType      │ 4 bytes  │ Constant (SIGHASH_ALL)          │
└────┴────────────────┴──────────┴─────────────────────────────────┘

sighash = SHA256(SHA256(preimage))
```

### Shared hash computation

```text
hashPrevouts = SHA256(SHA256(outpoint[0] || outpoint[1] || ... || outpoint[N]))
               where outpoint = txid(32 LE) || vout(4 LE)

hashSequence = SHA256(SHA256(sequence[0] || sequence[1] || ... || sequence[N]))

hashOutputs  = SHA256(SHA256(output[0] || output[1] || ...))
               where output = value(8 LE) || scriptPubKey_len(varint) || scriptPubKey
```

### Input set is fixed per session

With `SIGHASH_ALL` + BIP143, each signature commits to **the complete input set** via `hashPrevouts` and `hashSequence`. That means:

- You must know the full list of inputs (outpoints + sequences) before you can compute `hashPrevouts/hashSequence`.
- If you want to add/remove inputs, you must create a **new session** with new commitment hashes.

### Why parallel signing works

Once `hashPrevouts`, `hashSequence`, and `hashOutputs` are fixed:

- Each signature commits to the entire transaction (inputs + outputs) via these hashes.
- Each signature can be computed independently (each call only needs its own outpoint/script/amount/sequence plus the shared hashes).
- Signatures cannot be mixed across different transactions because different input/output sets change the commitments and therefore change the sighash.

---

## Contract model (Solana) and security invariants

### Trust architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│  DEX PROGRAM (Solana)                                            │
│                                                                  │
│  Responsibilities:                                               │
│  • Validate outputs intent: recipient script, vault change       │
│    script, and output count/shape                                │
│  • Compute/store hashOutputs from canonical output serialization │
│  • Enforce user balance cap (no signing beyond debit capacity)   │
│  • Track pending outpoints and session state                     │
│  • Only then CPI to MPC signing contract                         │
└───────────────────────────────┬──────────────────────────────────┘
                                │ CPI (only if verification passes)
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│  MPC SIGNER + OBSERVER                                           │
│                                                                  │
│  • Receives serialized per-input signing data                    │
│  • Deterministically constructs BIP143 preimage + signs sighash  │
│  • Observes Bitcoin for spends and reports confirmed results     │
└──────────────────────────────────────────────────────────────────┘
```

### Critical invariant: outputs are pinned once, then reused

Instead of passing `outputs` on every `sign_input`, the DEX pins the output commitment once:

1. User provides the intended `outputs` (usually 2 outputs).
2. DEX recomputes `hashOutputs = sha256d(serialize(outputs))` and stores it in a session.
3. Each `sign_input` uses the stored `hashOutputs` (and does not re-pass the raw outputs).

This keeps per-input signing calls constant-size while maintaining a strong commitment to outputs.

### Critical invariant: the MPC never signs a user-chosen digest

The DEX should only ever ask the MPC to sign a **structured** BIP143 signing payload (fields that deterministically map to the BIP143 preimage). Do not allow any path where a user supplies an arbitrary 32-byte digest to be signed.

### Critical invariant: prevent “over-signing” beyond the user’s balance cap

Pinned outputs (`hashOutputs`) ensure the transaction pays the intended scripts/amounts, but they do **not** bound how much value gets spent.

In Bitcoin, the fee is implicit:

```text
fee = sum(inputs) - sum(outputs)
```

So if the system can be tricked into signing **extra vault inputs** under the same pinned outputs, the “extra” value can only go to miners as additional fee.

Because the DEX debits the user’s on-chain balance to cover what the vault actually spends (including fee), the Solana program must ensure it never authorizes more input value than the user can cover.

Mitigation:

- The DEX maintains a **session** with a cap derived from the user’s balance (and the pinned outputs, if needed for accounting).
- Each `sign_input`:
  - reserves the `outpoint` (no double counting / double signing),
  - increments `authorized_input_total` by `amount_sats`,
  - rejects if the new total would exceed the session cap.

Result: the MPC cannot be used as a signing oracle to authorize spending vault value that the DEX cannot account for (even if the “attack” is just burning value as fees).

### Attack prevention

| Attack / failure mode                   | Mitigation                                                                 | Layer |
|----------------------------------------|----------------------------------------------------------------------------|-------|
| Lying about `hashOutputs`              | DEX recomputes `hashOutputs` from canonical output serialization and pins it | Solana |
| Malicious/incorrect outputs             | DEX validates output intent (e.g., vault change script)                     | Solana |
| Over-signing extra inputs               | Session balance cap + per-outpoint reservation                              | Solana |
| Serialization mismatch (invalid sigs)   | Canonical BIP143 encoding rules + test vectors for MPC implementation       | MPC   |

---

## Session + per-input signing flow

### 1) Create session (pin tx-wide fields)

The DEX creates and stores a session that pins tx-wide constants for all subsequent `sign_input` calls:

- `hashOutputs` (computed from provided outputs)
- `hashPrevouts` and `hashSequence` (provided as commitments computed off-chain from the full input set)
- `nVersion`, `nLockTime`, `nHashType` (`SIGHASH_ALL`)
- `user` + a balance-derived `cap_sats` (maximum value the session is allowed to authorize)

### 2) Sign input (one Solana tx per BTC input)

For each Bitcoin input, user calls `sign_input` and the DEX CPI’s to MPC signing.

`sign_input` parameters are per-input only (the session pins tx-wide constants):

```text
sign_input(session_id, outpoint, amount_sats, sequence, scriptCode)
```

The DEX then constructs the MPC signing payload by combining pinned session fields + per-input fields. Example shape:

```text
SignInputPayload {
  session_id:    [u8; 32]

  // tx-wide commitments / constants
  hashPrevouts:  [u8; 32]
  hashSequence:  [u8; 32]
  hashOutputs:   [u8; 32]   // taken from the pinned session
  nVersion:      u32
  nLockTime:     u32
  sighashType:   u32        // SIGHASH_ALL

  // per-input fields
  outpoint_txid: [u8; 32]
  outpoint_vout: u32
  amount_sats:   u64
  sequence:      u32
  scriptCode:    bytes
}
```

The MPC deterministically constructs the BIP143 preimage from this payload, computes `sha256d(preimage)`, and produces the ECDSA signature.

### Canonical encoding rules (must be specified)

To avoid “valid on Solana, invalid on Bitcoin” mismatches, the payload-to-preimage mapping must be exact:

- `txid` in `outpoint` is serialized **little-endian** in the preimage (i.e., reverse the usual RPC/display hex).
- Integers are **little-endian** (`u32`/`u64`).
- `scriptCode` is serialized as **varint length + bytes** in the preimage.
- `scriptCode` must follow BIP143 rules for the input type (e.g., P2WPKH uses P2PKH-style `scriptCode`).

---

## Data sizes

### Session creation (one-time)

- Includes `outputs` (for `hashOutputs` verification), so output count is limited by Solana tx space.
- Recommended: 2 outputs (recipient + vault change).

### Per-input signing call (constant-size)

Does **not** include raw outputs. Each per-input call is bounded by:

- Shared commitments/constants: `hashPrevouts + hashSequence + hashOutputs + version + locktime + sighashType`
- Unique per-input data: `outpoint + amount + sequence + scriptCode`

---

## MPC observation & confirmation callback

After signing, MPC observes Bitcoin and confirms each UTXO spend individually.

### What MPC tracks (per watched outpoint)

At minimum:

```text
WatchedUtxo {
  outpoint:     (txid, vout)
  session_id:   [u8; 32]   // or request_id, used to route callback
  // Optional cache:
  // hashOutputs: [u8; 32]
}
```

### Observation flow

```text
1) Watch outpoint (txid:vout) for being spent
2) When spent, determine spending_txid
3) Fetch spending tx, extract outputs
4) Wait for confirmation (finality threshold)
5) Call back to Solana with (outpoint, spending_txid, outputs, finality metadata) + MPC signature
```

### Bitcoin RPC methods (example)

- Check whether unspent: `gettxout <txid> <vout> [include_mempool=true]`  
  - returns JSON if unspent, `null` if spent (or pruned/unknown depending on node configuration)
- Find spender (Core 24+): `gettxspendingprevout`
- Fetch tx details: `getrawtransaction <spending_txid> true`

### What MPC signs (confirmation)

MPC signs a domain-separated digest of the callback payload:

```text
MPC signs: (outpoint, spending_txid, outputs, block_hash/height/confirmations)
signature = ECDSA_sign(MPC_key, keccak256(domain || payload))
```

### DEX callback handling

On receiving a confirmation callback:

1. Verify MPC signature (oracle authenticity).
2. Look up the pending entry by `outpoint`.
3. Recompute `sha256d(serialize(outputs))` and verify it matches the stored `hashOutputs` for the session.
4. Clear `PendingUtxos[outpoint]` **for every confirmed outpoint**.
5. Apply business logic once per `spending_txid` (dedup), but do not leave stale outpoints behind.

---

## Example flow (withdrawal)

```text
User                     DEX Program                 MPC                 Bitcoin
  │                          │                        │                     │
  │ create_session(outputs)  │                        │                     │
  ├─────────────────────────►│ pin hashOutputs        │                     │
  │                          │                        │                     │
  │ sign_input(outpoint_0)   │ reserve outpoint_0     │                     │
  ├─────────────────────────►│ CPI -> sign payload    ├────────────────────►│
  │◄──────── signature_0 ────┤                        │                     │
  │                          │                        │                     │
  │ sign_input(outpoint_1)   │ reserve outpoint_1     │                     │
  ├─────────────────────────►│ CPI -> sign payload    ├────────────────────►│
  │◄──────── signature_1 ────┤                        │                     │
  │                          │                        │                     │
  │ assemble + broadcast BTC tx ───────────────────────────────────────────►│
  │                          │                        │                     │
  │                          │                        │ observe confirmed spend
  │                          │◄──────── confirm(outpoint, txid, outputs, meta) + sig
  │ complete(confirm)        │ verify + clear pending │                     │
  ├─────────────────────────►│ apply once per txid    │                     │
```
