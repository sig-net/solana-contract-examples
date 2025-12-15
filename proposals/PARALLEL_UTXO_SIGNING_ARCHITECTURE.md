# Parallel UTXO Signing Architecture

> **Status:** Proposal
> **Last Updated:** 2024-12

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
- **Outputs:** Fixed shape of **2 outputs**: user withdrawal + vault change.
- **MPC signing request:** MPC receives **serialized per-input signing data** (not a precomputed digest) and constructs the BIP143 preimage deterministically.

---

## Threat model

**Single invariant:** A user must not be able to extract vault value beyond their reserved balance.

```
vault_value_spent ≤ user_balance_reserved
```

Invalid signatures, failed broadcasts, or wasted gas are the user's problem—not security concerns.

---

## Security model

### Why the invariant holds

The math that guarantees no theft:

```text
At session creation:
  user_cost            = user_out + declared_fee        ← reserved from balance
  expected_input_total = user_out + vault_change + declared_fee

At signing:
  authorized_input_total ≤ expected_input_total         ← enforced

Net vault loss:
  vault_loss = sum(inputs) - vault_change
             = authorized_input_total - vault_change
             ≤ (user_out + vault_change + declared_fee) - vault_change
             = user_out + declared_fee
             = user_cost  ✓

Therefore: vault_loss ≤ user_cost  (always)
```

### Three mechanisms enforce this invariant

| Mechanism | What it prevents | Why it's required |
|-----------|------------------|-------------------|
| **Balance reservation** | User creating sessions exceeding their balance | Without this, user could sign without funds to back it |
| **Input accumulation bound** | User signing more inputs than `sum(outputs) + fee` | Without this, excess inputs become unaccounted fee (vault drain) |
| **Change address validation** | User claiming change while only paying `user_out + fee` | Without this, the math breaks (see below) |

**Remove any one mechanism and the invariant breaks.**

### Why change address validation is mathematically required

This isn't just "good hygiene"—it's essential for the math to work.

If user could set change output to their own address:

```text
Example attack:
  Output 0: 5 BTC → user's withdrawal address
  Output 1: 3 BTC → user's SECOND address (fake "vault change")
  declared_fee: 2 BTC

  user_cost = 5 + 2 = 7 BTC  (what user pays)
  User signs 10 BTC of inputs
  User receives: 5 + 3 = 8 BTC

  Theft: 1 BTC (user paid 7, received 8)
```

The `user_cost` formula is `user_out + declared_fee`. It does NOT include `vault_change` because that's supposed to return to the vault. If user steals the change, they extract `vault_change` worth of value without paying for it.

**Enforcing change → vault address closes this gap.**

### Summary table

| What user controls | What DEX enforces | Result |
|-------------------|-------------------|--------|
| Withdrawal amount | Change output → vault address | User can't steal change |
| Fee amount | `sum(inputs) ≤ outputs + declared_fee` | User can't inflate fees |
| Which inputs to sign | Balance reserved at session creation | User can't outrun their balance |
| Session ID | Derived from commitments | User can't hijack sessions |
| Input amounts | BIP143 commits to amount | User can't lie (only hurts themselves) |

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
│  • Derive session_id from commitment hashes (never user-provided)│
│  • Validate outputs: user withdrawal + vault change scripts      │
│  • Compute/store hashOutputs from canonical output serialization │
│  • Reserve user balance (fee + withdrawal) at session creation   │
│  • Enforce input accumulation bound: sum(inputs) <= expected     │
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

---

## Security invariants

### 1. Session ID is derived, never user-provided

The `session_id` **must** be deterministically derived from the transaction commitment hashes:

```text
session_id = sha256(hashPrevouts || hashSequence || hashOutputs || user_pubkey)
```

**Why this matters:**

- **Prevents session confusion attacks:** A user-provided session ID could collide with or reference another user's session, potentially hijacking signing state or causing accounting errors.
- **Ensures deterministic verification:** Given the same commitments and user, the session ID is always the same. The DEX can verify any `sign_input` call references the correct session by recomputing the ID from stored commitments.
- **Prevents replay across sessions:** Each unique transaction shape produces a unique session ID. Signatures and state cannot be misattributed across different withdrawal attempts.
- **Idempotent session creation:** If a user calls `create_session` twice with identical parameters, they get the same session ID (reject duplicate or treat as no-op).

**Implementation note:** The session PDA seed should include this derived `session_id`, making it impossible to create conflicting sessions.

---

### 2. Explicit fee declaration with optimistic balance reservation

The session **must** include an explicit `declared_fee` amount. Balance is **reserved** (not just checked) at session creation, and input accumulation is strictly bounded.

**Session creation parameters:**

```text
create_session {
  outputs: [
    { script: user_withdrawal_script, amount: user_out_sats },
    { script: vault_change_script,    amount: vault_change_sats }
  ],
  declared_fee:  u64,
  hashPrevouts:  [u8; 32],
  hashSequence:  [u8; 32],
  nVersion:      u32,
  nLockTime:     u32
}
```

**DEX computes and stores:**

```text
sum_outputs          = user_out_sats + vault_change_sats
expected_input_total = sum_outputs + declared_fee
user_cost            = user_out_sats + declared_fee   // what user pays
```

**Optimistic balance reservation (CRITICAL):**

At session creation, DEX **immediately reserves** `user_cost` from the user's available balance:

```text
require!(user.available_balance >= user_cost)
user.available_balance -= user_cost
user.reserved_balance  += user_cost
```

This **prevents race conditions** where a user:
1. Creates session with balance = 10 BTC
2. Transfers 10 BTC to another account
3. Completes signing with 0 BTC backing

With reservation, step 2 would fail because the balance is locked.

**Input accumulation bound (CRITICAL):**

During each `sign_input`, DEX enforces:

```text
require!(authorized_input_total + amount_sats <= expected_input_total,
         "Input total exceeds declared fee + outputs - potential theft")

authorized_input_total += amount_sats
```

**Why this prevents theft:**

If user signs more inputs than `expected_input_total`:
- Outputs are pinned (can't change)
- Excess value goes to miners as implicit fee
- User only reserved `user_cost`, but vault loses more

By enforcing `sum(inputs) <= sum(outputs) + declared_fee`, we guarantee:
- Fee cannot exceed what user declared
- No "fee inflation" attack to drain vault to miners
- User pays for exactly what they authorized

---

### 3. Change output MUST go to vault address

The DEX **must** validate that the change output scriptPubKey matches a known vault address.

```text
require!(outputs[0].script == user_provided_withdrawal_address)
require!(outputs[1].script == KNOWN_VAULT_SCRIPT_PUBKEY,
         "Change must go to vault")
```

**Why this is mathematically required (not just good hygiene):**

The `user_cost` formula is `user_out + declared_fee`. It does NOT include `vault_change` because that value is supposed to return to the vault. If the user could direct change to themselves, they extract `vault_change` worth of value without paying for it.

See the [Security Model](#why-change-address-validation-is-mathematically-required) section for the detailed proof and attack example.

**Implementation:** DEX maintains the vault's scriptPubKey(s). Session creation fails if change output script doesn't match.

---

### 4. Balance debit based on authorized inputs, not outputs

On session completion/confirmation, DEX debits based on what was **actually authorized** (`authorized_input_total`), not `sum(outputs)`.

**Why this matters:**

Bitcoin fee is implicit: `fee = sum(inputs) - sum(outputs)`.

If DEX debited based on outputs only:
```
Outputs = 5 BTC, Inputs signed = 10 BTC
Fee = 5 BTC (implicit)
DEX debits user: 5 BTC (based on outputs)
Vault loses: 10 BTC of UTXOs
Gap: 5 BTC subsidized by vault → leaked to miners
```

By debiting `authorized_input_total`:
```
DEX debits user: 10 BTC (what they signed)
Vault loses: 10 BTC of UTXOs
User receives: 5 BTC (outputs - change)
Fee: 5 BTC (paid by user from their 10 BTC)
Balance: correct
```

**Note:** With invariant #2, we already bound `authorized_input_total <= expected_input_total`. Combined with upfront reservation of `user_cost = user_out + declared_fee`, accounting is guaranteed correct.

---

### 5. Outputs are pinned once, then reused

Instead of passing `outputs` on every `sign_input`, the DEX pins the output commitment once:

1. User provides the intended `outputs` (usually 2 outputs).
2. DEX validates scripts (user withdrawal address + vault change address).
3. DEX recomputes `hashOutputs = sha256d(serialize(outputs))` and stores it in session.
4. Each `sign_input` uses the stored `hashOutputs` (does not re-pass raw outputs).

This keeps per-input signing calls constant-size while maintaining a strong commitment to outputs.

---

### 6. MPC never signs a user-chosen digest

The DEX should only ever ask the MPC to sign a **structured** BIP143 signing payload (fields that deterministically map to the BIP143 preimage). Do not allow any path where a user supplies an arbitrary 32-byte digest to be signed.

**Why this matters:**

If MPC signed arbitrary 32-byte digests, a malicious user could:
1. Compute their own sighash for a completely different transaction
2. Submit it as "payload" through some other code path
3. Get MPC signature for an unauthorized transaction

By requiring structured input (outpoint, amount, scriptCode, commitments), the MPC constructs the preimage itself. Signatures are only valid for the declared transaction shape.

---

### 7. BIP143 amount commitment prevents lying about UTXO values

BIP143's sighash preimage includes the input `amount` (field #6). This is a critical security property inherited from Bitcoin's SegWit design:

- If user claims UTXO is worth 1 BTC but actual on-chain value is 5 BTC
- MPC builds preimage with `amount = 1 BTC`
- Resulting signature is **invalid** on Bitcoin (amount mismatch in sighash)

**Users cannot lie about input amounts to the MPC.** Wrong amounts produce invalid signatures. This is the user's problem (wasted gas), not a vault theft vector.

This property is why we can trust user-provided `amount_sats` for accounting purposes—if they lie, they only hurt themselves.

---

### Attack prevention summary

| Attack / Failure Mode | Mitigation | Layer |
|----------------------|------------|-------|
| User-provided session ID collision | Derive `session_id = sha256(commitments \|\| user)` | Solana |
| Fee inflation (drain vault to miners) | Explicit `declared_fee` + bound `sum(inputs) <= expected` | Solana |
| Steal change output | Validate change scriptPubKey matches vault address | Solana |
| Balance race condition | Reserve balance at session creation, not just check | Solana |
| Debit mismatch (under-charge user) | Debit based on `authorized_input_total` | Solana |
| Lying about `hashOutputs` | DEX recomputes from canonical serialization | Solana |
| Lying about input amounts | BIP143 commits to amount; wrong = invalid signature | Bitcoin |
| MPC as arbitrary signing oracle | Only structured BIP143 payloads accepted | MPC |
| Serialization mismatch | Canonical BIP143 encoding rules + test vectors | MPC |

---

## Session + per-input signing flow

### 1) Create session (pin tx-wide fields + reserve balance)

User calls `create_session` with transaction parameters:

```text
create_session {
  // Outputs (DEX validates and computes hashOutputs)
  outputs: [
    { script: user_withdrawal_script, amount: user_out_sats },
    { script: vault_change_script,    amount: vault_change_sats }
  ],

  // Explicit fee declaration
  declared_fee: u64,

  // Input set commitments (computed off-chain from full input list)
  hashPrevouts: [u8; 32],
  hashSequence: [u8; 32],

  // Transaction constants
  nVersion:  u32,
  nLockTime: u32
}
```

**DEX performs the following (atomically):**

```text
// 1. Validate outputs
require!(outputs[1].script == VAULT_SCRIPT_PUBKEY, "Change must go to vault")

// 2. Compute commitments
hashOutputs = sha256d(serialize(outputs))
sum_outputs = user_out_sats + vault_change_sats
expected_input_total = sum_outputs + declared_fee
user_cost = user_out_sats + declared_fee

// 3. Derive session ID (NEVER user-provided)
session_id = sha256(hashPrevouts || hashSequence || hashOutputs || user_pubkey)

// 4. Reserve balance (prevents race conditions)
require!(user.available_balance >= user_cost, "Insufficient balance")
user.available_balance -= user_cost
user.reserved_balance  += user_cost

// 5. Create session PDA with derived session_id as seed
Session {
  session_id,
  user: user_pubkey,
  hashPrevouts,
  hashSequence,
  hashOutputs,
  nVersion,
  nLockTime,
  declared_fee,
  expected_input_total,
  user_cost,
  authorized_input_total: 0,
  status: Active
}
```

### 2) Sign input (one Solana tx per BTC input)

For each Bitcoin input, user calls `sign_input`:

```text
sign_input(session_id, outpoint, amount_sats, sequence, scriptCode)
```

**DEX validation:**

```text
// 1. Load session by session_id
session = load_session(session_id)
require!(session.user == caller, "Not session owner")
require!(session.status == Active, "Session not active")

// 2. Check input accumulation bound (CRITICAL for theft prevention)
require!(session.authorized_input_total + amount_sats <= session.expected_input_total,
         "Input total exceeds declared fee + outputs")

// 3. Reserve outpoint (prevent double-signing)
require!(!is_outpoint_reserved(outpoint), "Outpoint already reserved")
reserve_outpoint(outpoint, session_id)

// 4. Update accumulator
session.authorized_input_total += amount_sats
```

**DEX constructs MPC signing payload:**

```text
SignInputPayload {
  session_id:    [u8; 32]

  // tx-wide commitments (from session)
  hashPrevouts:  [u8; 32]
  hashSequence:  [u8; 32]
  hashOutputs:   [u8; 32]
  nVersion:      u32
  nLockTime:     u32
  sighashType:   u32        // SIGHASH_ALL = 0x01

  // per-input fields (from call)
  outpoint_txid: [u8; 32]
  outpoint_vout: u32
  amount_sats:   u64
  sequence:      u32
  scriptCode:    bytes
}
```

MPC deterministically constructs the BIP143 preimage from this payload, computes `sha256d(preimage)`, and produces the ECDSA signature.

### Canonical encoding rules (must be specified)

To avoid "valid on Solana, invalid on Bitcoin" mismatches, the payload-to-preimage mapping must be exact:

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
  │ create_session(          │                        │                     │
  │   outputs,               │                        │                     │
  │   declared_fee,          │                        │                     │
  │   hashPrevouts,          │                        │                     │
  │   hashSequence           │                        │                     │
  │ )                        │                        │                     │
  ├─────────────────────────►│                        │                     │
  │                          │ 1. validate change → vault                   │
  │                          │ 2. compute hashOutputs                       │
  │                          │ 3. derive session_id                         │
  │                          │ 4. RESERVE user balance                      │
  │                          │ 5. create session PDA                        │
  │◄──────── session_id ─────┤                        │                     │
  │                          │                        │                     │
  │ sign_input(              │                        │                     │
  │   session_id,            │                        │                     │
  │   outpoint_0,            │                        │                     │
  │   amount_sats_0          │                        │                     │
  │ )                        │                        │                     │
  ├─────────────────────────►│                        │                     │
  │                          │ check: sum <= expected │                     │
  │                          │ reserve outpoint_0     │                     │
  │                          │ authorized += amount_0 │                     │
  │                          │ CPI -> sign payload    ├────────────────────►│
  │◄──────── signature_0 ────┤                        │                     │
  │                          │                        │                     │
  │ sign_input(outpoint_1)   │                        │                     │
  ├─────────────────────────►│ check: sum <= expected │                     │
  │                          │ reserve outpoint_1     │                     │
  │                          │ CPI -> sign payload    ├────────────────────►│
  │◄──────── signature_1 ────┤                        │                     │
  │                          │                        │                     │
  │ assemble + broadcast BTC tx ───────────────────────────────────────────►│
  │                          │                        │                     │
  │                          │                        │ observe confirmed   │
  │                          │                        │ spend               │
  │                          │◄─── confirm(outpoint, txid, outputs) + sig ──┤
  │                          │ verify MPC signature   │                     │
  │                          │ verify hashOutputs     │                     │
  │                          │ finalize debit         │                     │
  │                          │ clear pending          │                     │
```

### Key security checkpoints in this flow

1. **Session creation:** Balance reserved immediately; session_id derived (not user-chosen)
2. **Each sign_input:** `authorized_input_total + amount <= expected_input_total` enforced
3. **Confirmation:** Only valid if outputs match pinned `hashOutputs`

---

## Security Assessment

### 1. Executive Summary

This assessment evaluates the Parallel UTXO Signing Architecture against its stated threat model: **preventing users from extracting vault value beyond their reserved balance**.

**Verdict: SECURE** — The design achieves the security goal through three interlocking mechanisms that together enforce the core invariant. No attack vector was identified that allows a user to extract more value than they reserve.

---

### 2. Scope and Threat Model

**In scope:**
- User attempting to steal funds (extract more than their balance)
- User attempting to drain vault (unauthorized value extraction)
- User manipulating session state, outputs, fees, or inputs

**Out of scope (explicitly not security concerns):**
- Invalid signatures (user's problem — wasted gas)
- Failed broadcasts (user's problem)
- MPC compromise (trusted component, 5-of-8 threshold)
- Solana program bugs (implementation, not design)
- Bitcoin reorgs (operational concern, not theft vector)

**Core invariant to verify:**

```
vault_value_spent ≤ user_balance_reserved
```

---

### 3. Attack Surface Analysis

| Component | User-Controlled Inputs | Trust Boundary |
|-----------|----------------------|----------------|
| `create_session` | outputs, declared_fee, hashPrevouts, hashSequence | DEX validates all |
| `sign_input` | session_id, outpoint, amount_sats, sequence, scriptCode | DEX validates against session |
| MPC signing | None (receives structured payload from DEX) | Trusted |
| Bitcoin broadcast | Full transaction | User responsibility |
| Confirmation callback | None (MPC-initiated) | MPC trusted |

---

### 4. Attack Vector Enumeration and Analysis

#### Attack 1: Steal change by directing to user's address

**Attack:** User sets `outputs[1]` to their own address instead of vault.

**Analysis:**
```
user_cost = user_out + declared_fee  (does NOT include vault_change)
If user steals vault_change:
  user_receives = user_out + vault_change
  user_pays = user_out + declared_fee
  theft = vault_change
```

**Mitigation:** DEX validates `outputs[1].script == VAULT_SCRIPT_PUBKEY`

**Status:** ✅ MITIGATED

---

#### Attack 2: Inflate fee to drain vault

**Attack:** User signs more inputs than `sum(outputs) + declared_fee`, excess goes to miners.

**Analysis:**
```
If authorized_input_total > expected_input_total:
  actual_fee = authorized_input_total - sum(outputs)
  actual_fee > declared_fee
  Vault loses extra value to miners
```

**Mitigation:** DEX enforces `authorized_input_total ≤ expected_input_total`

**Status:** ✅ MITIGATED

---

#### Attack 3: Race condition — withdraw balance after session creation

**Attack:**
1. User creates session (balance check passes)
2. User transfers balance elsewhere
3. User completes signing with no backing funds

**Analysis:** If balance is only checked (not reserved), user can drain without funds.

**Mitigation:** Balance is **reserved** (moved to `reserved_balance`) at session creation, not just checked.

**Status:** ✅ MITIGATED

---

#### Attack 4: Session ID collision/hijacking

**Attack:** User provides crafted session_id to reference another user's session or create confusion.

**Analysis:** If session_id is user-provided:
- Could collide with existing session
- Could reference another user's session state
- Could cause accounting errors

**Mitigation:** `session_id = sha256(hashPrevouts || hashSequence || hashOutputs || user_pubkey)` — deterministically derived, never user-provided.

**Status:** ✅ MITIGATED

---

#### Attack 5: Lie about input amounts

**Attack:** User claims UTXO is worth less than actual value to reduce reserved balance.

**Analysis:**
```
If user claims 1 BTC but UTXO is actually 5 BTC:
  MPC builds BIP143 preimage with amount = 1 BTC
  Signature is INVALID on Bitcoin (amount committed in sighash)
```

**Mitigation:** BIP143 commits to input amount. Wrong amount = invalid signature (user's problem).

**Status:** ✅ NOT A THREAT (self-defeating attack)

---

#### Attack 6: Lie about hashPrevouts/hashSequence

**Attack:** User provides fraudulent commitment hashes.

**Analysis:**
- If commitments don't match actual inputs, signatures are invalid
- User wastes their own gas
- No vault funds at risk

**Mitigation:** Inherent in BIP143 — wrong commitments produce unusable signatures.

**Status:** ✅ NOT A THREAT (self-defeating attack)

---

#### Attack 7: Double-sign same outpoint across sessions

**Attack:** User creates two sessions including the same UTXO, signs it in both.

**Analysis:**
- Bitcoin consensus prevents double-spend
- Only one transaction can confirm
- Second session's signatures are useless
- User may over-reserve balance (their problem)

**Mitigation:** Bitcoin's double-spend protection. Optionally, DEX can track global outpoint reservations for UX.

**Status:** ✅ NOT A THREAT (Bitcoin consensus)

---

#### Attack 8: MPC as signing oracle for arbitrary digests

**Attack:** User somehow gets MPC to sign arbitrary 32-byte digest.

**Analysis:** If MPC signed arbitrary digests, user could craft any transaction.

**Mitigation:** MPC only accepts structured `SignInputPayload` and constructs BIP143 preimage itself. No code path for arbitrary digest signing.

**Status:** ✅ MITIGATED (by design)

---

#### Attack 9: Manipulate outputs after session creation

**Attack:** User creates session with valid outputs, then changes them before signing.

**Analysis:** `hashOutputs` is pinned at session creation. Signatures commit to this hash. Changed outputs = invalid signatures.

**Mitigation:** Inherent in BIP143 — outputs are cryptographically committed.

**Status:** ✅ NOT A THREAT (cryptographic binding)

---

### 5. Formal Verification of Core Invariant

**Claim:** `vault_loss ≤ user_cost` always holds.

**Proof:**

```
Definitions:
  user_cost            = user_out + declared_fee
  expected_input_total = user_out + vault_change + declared_fee

Enforced constraint:
  authorized_input_total ≤ expected_input_total

Vault loss calculation:
  vault_loss = sum(inputs_spent) - vault_change_received
             = authorized_input_total - vault_change

Substituting the constraint:
  vault_loss ≤ expected_input_total - vault_change
             = (user_out + vault_change + declared_fee) - vault_change
             = user_out + declared_fee
             = user_cost

Therefore: vault_loss ≤ user_cost  ∎
```

**Dependencies for proof validity:**
1. `vault_change` actually goes to vault (enforced by change address validation)
2. `authorized_input_total` can't exceed `expected_input_total` (enforced by accumulation bound)
3. `user_cost` is reserved from user's balance (enforced by balance reservation)

All three dependencies are enforced by the design. The proof holds.

---

### 6. Edge Cases and Assumptions

| Edge Case | Handling |
|-----------|----------|
| User creates session but never signs | Balance stays reserved; session expires (needs expiration mechanism) |
| User signs fewer inputs than expected | Transaction may fail or have lower fee; user's problem |
| User's balance decreases during signing | Already reserved; other operations fail, not this session |
| Multiple concurrent sessions | Each reserves its own balance; total can't exceed available |
| Session with 0 vault_change | Valid; user pays `user_out + fee`, vault gets no change back |
| Session with 0 declared_fee | Valid but transaction may not relay; user's problem |

**Assumption:** MPC is honest (or Byzantine-fault-tolerant with 5-of-8 threshold). If MPC is fully compromised, it could sign arbitrary transactions regardless of DEX constraints.

---

### 7. Residual Risks

| Risk | Severity | Notes |
|------|----------|-------|
| MPC compromise | Critical | Out of scope; mitigated by threshold cryptography |
| Solana program bugs | High | Implementation risk, not design flaw |
| Session state bloat | Low | Need expiration/cleanup mechanism |
| Bitcoin reorg after confirmation | Medium | Operational; could double-credit if not handled |

---

### 8. Conclusion

The Parallel UTXO Signing Architecture is **secure against its stated threat model**.

The core invariant `vault_value_spent ≤ user_balance_reserved` is mathematically guaranteed by three interlocking mechanisms:

1. **Balance reservation** — locks funds at session creation
2. **Input accumulation bound** — caps total signable value
3. **Change address validation** — ensures vault receives its change

Each mechanism is necessary; removing any one breaks the invariant. Together, they form a complete defense against user theft and vault drain.

**Recommendation:** Proceed with implementation, ensuring:
- All three mechanisms are implemented atomically
- Session expiration/cleanup is added for operational hygiene
- Comprehensive test coverage for each attack vector
- MPC threshold security is maintained (5-of-8)
