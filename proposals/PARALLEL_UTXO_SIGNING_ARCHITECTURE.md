# Parallel UTXO Signing Architecture

> **Status:** Proposal
> **Last Updated:** 2024-12

---

## Problem

Solana transactions are limited to ~1232 bytes. Bitcoin transaction data scales roughly linearly with inputs, so sending full Bitcoin transaction/PSBT data through Solana quickly hits limits (~3–5 inputs).

**Goal:** Enable unlimited UTXO inputs for vault consolidation and large withdrawals by signing inputs in parallel across multiple Solana transactions.

---

## Solution

Leverage BIP143's SegWit v0 sighash structure to sign each input independently in separate Solana transactions, while all signatures still commit to the same Bitcoin inputs + outputs.

**Key insight:** In BIP143 with `SIGHASH_ALL`, the sighash preimage contains three transaction-wide 32-byte commitments that are constant for all inputs:

- `hashPrevouts` (commits to all input outpoints)
- `hashSequence` (commits to all input sequences)
- `hashOutputs` (commits to all outputs)

Instead of passing a full PSBT, pass only these commitments + per-input fields.

---

## Scope / Assumptions

- **Bitcoin inputs:** SegWit v0 spends using **BIP143** and **ECDSA** signatures with `SIGHASH_ALL` (e.g., P2WPKH / P2WSH / nested SegWit).
- **Outputs:** Fixed shape of **2 outputs**: user withdrawal + vault change.
- **MPC signing request:** MPC receives **serialized per-input signing data** (not a precomputed digest) and constructs the BIP143 preimage deterministically.

---

## Threat Model

**Single invariant:** A user must not be able to extract vault value beyond their reserved balance.

```
vault_value_spent ≤ user_balance_reserved
```

Invalid signatures, failed broadcasts, or wasted gas are the user's problem—not security concerns.

---

## Security Model

### Why the Invariant Holds

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

### Three Mechanisms Enforce This Invariant

| Mechanism | What it prevents | Why it's required |
|-----------|------------------|-------------------|
| **Balance reservation** | User creating sessions exceeding their balance | Without this, user could sign without funds to back it |
| **Input accumulation bound** | User signing more inputs than `sum(outputs) + fee` | Without this, excess inputs become unaccounted fee (vault drain) |
| **Change address validation** | User claiming change while only paying `user_out + fee` | Without this, the math breaks (see below) |

**Remove any one mechanism and the invariant breaks.**

### Why Change Address Validation is Mathematically Required

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

### Summary Table

| What user controls | What DEX enforces | Result |
|-------------------|-------------------|--------|
| Withdrawal amount | Change output → vault address | User can't steal change |
| Fee amount | `sum(inputs) ≤ outputs + declared_fee` | User can't inflate fees |
| Which inputs to sign | Balance reserved at session creation | User can't outrun their balance |
| Session ID | Derived from commitments | User can't hijack sessions |
| Input amounts | BIP143 commits to amount | User can't lie (only hurts themselves) |

---

## BIP143 Sighash Preimage (Per Input)

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

### Shared Hash Computation

```text
hashPrevouts = SHA256(SHA256(outpoint[0] || outpoint[1] || ... || outpoint[N]))
               where outpoint = txid(32 LE) || vout(4 LE)

hashSequence = SHA256(SHA256(sequence[0] || sequence[1] || ... || sequence[N]))

hashOutputs  = SHA256(SHA256(output[0] || output[1] || ...))
               where output = value(8 LE) || scriptPubKey_len(varint) || scriptPubKey
```

### Why Parallel Signing Works

Once `hashPrevouts`, `hashSequence`, and `hashOutputs` are fixed:

- Each signature commits to the entire transaction (inputs + outputs) via these hashes.
- Each signature can be computed independently (each call only needs its own outpoint/script/amount/sequence plus the shared hashes).
- Signatures cannot be mixed across different transactions because different input/output sets change the commitments and therefore change the sighash.

### Why Session Splitting Attack is Impossible

A user might attempt to split a multi-input transaction across separate sessions to bypass the accumulation bound:

```text
Attack attempt:
  Transaction has 3 inputs (10 BTC each = 30 BTC total)
  User tries to create 3 sessions, each signing 1 input
  Hope: bypass accumulation bound by distributing across sessions
```

**This attack fails due to BIP143's cryptographic structure:**

1. For signatures to combine into a valid Bitcoin transaction, they must ALL commit to the **same** `hashPrevouts` (hash of ALL inputs).

2. The session ID is derived from commitments:
   ```
   session_id = sha256(hashPrevouts || hashSequence || hashOutputs || user_pubkey)
   ```

3. If user provides correct `hashPrevouts` (all 3 inputs) for all sessions → **same session_id** → they collapse into ONE session.

4. If user lies about `hashPrevouts` (different per session) → signatures commit to different input sets → **signatures are incompatible** and cannot form a valid Bitcoin transaction.

**The cryptographic structure of BIP143 forces all inputs of one transaction into one session.** The accumulation bound is therefore always enforced across the complete input set.

---

## Contract Model (Solana)

### Trust Architecture

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
│  • Track session state                                           │
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
│  • Reports failure ONLY when UTXO deemed impossible to spend     │
└──────────────────────────────────────────────────────────────────┘
```

---

## Security Invariants

### 1. Session ID is Derived, Never User-Provided

The `session_id` **must** be deterministically derived from the transaction commitment hashes:

```text
session_id = sha256(hashPrevouts || hashSequence || hashOutputs || user_pubkey)
```

**Why this matters:**

- **Prevents session confusion attacks:** A user-provided session ID could collide with or reference another user's session.
- **Ensures deterministic verification:** Given the same commitments and user, the session ID is always the same.
- **Prevents replay across sessions:** Each unique transaction shape produces a unique session ID.
- **Idempotent session creation:** If a user calls `create_session` twice with identical parameters, they get the same session ID (reject duplicate or treat as no-op).
- **Forces transaction integrity:** As shown above, this derivation makes session splitting attacks impossible.

**Implementation note:** The session PDA seed should include this derived `session_id`, making it impossible to create conflicting sessions.

---

### 2. Explicit Fee Declaration with Optimistic Balance Reservation

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

---

### 3. Change Output MUST Go to Vault Address

The DEX **must** validate that the change output scriptPubKey matches a known vault address.

```text
require!(outputs[0].script == user_provided_withdrawal_address)
require!(outputs[1].script == KNOWN_VAULT_SCRIPT_PUBKEY,
         "Change must go to vault")
```

**Implementation:** DEX maintains the vault's scriptPubKey(s). Session creation fails if change output script doesn't match.

---

### 4. Outpoint Reuse Across Sessions

**Outpoints CAN be reused across multiple sessions.** The DEX does NOT lock outpoints globally.

**Why this is allowed:**

1. **Bitcoin consensus prevents double-spend:** Only ONE transaction using a given UTXO can ever confirm.

2. **Multiple sessions, one winner:** If user creates sessions A and B both using UTXO X:
   - User reserves `user_cost_A` + `user_cost_B`
   - User signs in both sessions
   - User broadcasts one transaction (say, A)
   - Transaction A confirms → Session A succeeds
   - UTXO X is now spent → Session B becomes **impossible**
   - Session B's reserved balance is **refunded**

3. **User bears optionality cost:** Creating multiple sessions for the same UTXOs locks more capital. This is the user's choice and their cost.

4. **No vault risk:** The invariant `vault_loss ≤ user_cost` holds per-session. Multiple sessions just mean multiple reservations; only one can succeed.

**Use case:** User may want transaction flexibility (different fee levels, different output amounts) and prepare multiple options. They pay for this optionality via locked capital.

---

### 5. Session Lifecycle: No Time-Based Expiration

Sessions do **NOT** expire based on time. A session resolves only when its fate is determined on Bitcoin:

**Success path (transaction confirms):**

```text
1. MPC observes UTXO spent on Bitcoin
2. MPC verifies: sha256d(actual_outputs) == session.hashOutputs
3. MPC calls confirm_success() on Solana with signed attestation
4. DEX finalizes: reserved_balance → permanently spent
5. Session closed
```

**Failure path (UTXO becomes impossible to spend):**

```text
1. MPC observes UTXO spent by a DIFFERENT transaction
   (actual_outputs hash does NOT match session.hashOutputs)
2. MPC calls confirm_impossible() on Solana with signed attestation
3. DEX refunds: reserved_balance → available_balance
4. Session closed
```

**Why no time-based expiration:**

- **Simplifies the model:** Session fate is determined by Bitcoin state, not wall-clock time.
- **No race conditions:** No timing attacks around expiration boundaries.
- **Clear resolution:** Every session eventually resolves (UTXO is either spent by this tx, or by another).

**User-initiated cancellation (before any signing):**

```text
1. User calls cancel_session()
2. Only allowed if authorized_input_total == 0 (no signatures issued)
3. DEX refunds: reserved_balance → available_balance
4. Session closed
```

**Note:** Once signatures are issued, user cannot cancel. They must either broadcast and complete, or wait for the UTXO to be spent elsewhere (which triggers refund). This prevents griefing where user gets signatures then cancels.

**Stuck session scenario:** If user signs but never broadcasts, and the UTXOs are vault-controlled (only spendable by vault), the session remains active indefinitely. However:
- User's balance is locked (their problem)
- User holds valid signatures and can complete anytime
- This is economically equivalent to having an unconfirmed transaction pending

---

### 6. MPC Never Signs a User-Chosen Digest

The DEX should only ever ask the MPC to sign a **structured** BIP143 signing payload (fields that deterministically map to the BIP143 preimage). Do not allow any path where a user supplies an arbitrary 32-byte digest to be signed.

**Why this matters:**

If MPC signed arbitrary 32-byte digests, a malicious user could:
1. Compute their own sighash for a completely different transaction
2. Submit it as "payload" through some other code path
3. Get MPC signature for an unauthorized transaction

By requiring structured input (outpoint, amount, scriptCode, commitments), the MPC constructs the preimage itself. Signatures are only valid for the declared transaction shape.

---

### 7. BIP143 Amount Commitment Prevents Lying About UTXO Values

BIP143's sighash preimage includes the input `amount` (field #6). This is a critical security property inherited from Bitcoin's SegWit design:

- If user claims UTXO is worth 1 BTC but actual on-chain value is 5 BTC
- MPC builds preimage with `amount = 1 BTC`
- Resulting signature is **invalid** on Bitcoin (amount mismatch in sighash)

**Users cannot lie about input amounts to the MPC.** Wrong amounts produce invalid signatures. This is the user's problem (wasted gas), not a vault theft vector.

This property is why we can trust user-provided `amount_sats` for accounting purposes—if they lie, they only hurt themselves.

---

## Session + Per-Input Signing Flow

### 1) Create Session (Pin TX-Wide Fields + Reserve Balance)

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

### 2) Sign Input (One Solana TX Per BTC Input)

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

// 3. Update accumulator
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

### Canonical Encoding Rules

To avoid "valid on Solana, invalid on Bitcoin" mismatches, the payload-to-preimage mapping must be exact:

- `txid` in `outpoint` is serialized **little-endian** in the preimage (i.e., reverse the usual RPC/display hex).
- Integers are **little-endian** (`u32`/`u64`).
- `scriptCode` is serialized as **varint length + bytes** in the preimage.
- `scriptCode` must follow BIP143 rules for the input type (e.g., P2WPKH uses P2PKH-style `scriptCode`).

---

## MPC Observation & Confirmation Callback

After signing, MPC observes Bitcoin and reports session outcomes. The MPC acts as an oracle that attests to Bitcoin state changes.

### What MPC Tracks

```text
WatchedOutpoint {
  outpoint:      (txid, vout)
  sessions:      Vec<session_id>   // Multiple sessions can reference same outpoint
  hashOutputs:   [u8; 32]          // Per-session expected outputs
}
```

### Observation Flow

```text
1) Watch outpoint (txid:vout) for being spent
2) When spent, determine spending_txid
3) Fetch spending tx, extract actual outputs
4) Compute actual_hashOutputs = sha256d(serialize(actual_outputs))
5) Wait for finality (6 confirmations)
6) For each session referencing this outpoint:
   - If actual_hashOutputs == session.hashOutputs → SUCCESS
   - If actual_hashOutputs != session.hashOutputs → IMPOSSIBLE (refund)
7) Call back to Solana with signed attestation
```

---

### Success Conditions

A session is marked **SUCCESS** when ALL of the following are true:

| Condition | Verification | Why Required |
|-----------|--------------|--------------|
| UTXO is spent | `gettxout` returns null | Confirms transaction was mined |
| 6+ confirmations | Block depth ≥ 6 | Bitcoin finality threshold; reorg probability < 0.1% |
| Outputs match | `sha256d(actual_outputs) == session.hashOutputs` | Ensures correct withdrawal + change amounts |

**Finality threshold rationale:**

- **6 confirmations** is the Bitcoin ecosystem standard for high-value transactions
- At 6 blocks deep, reversing the transaction requires > 50% hashrate sustained attack
- For most practical purposes, 6 confirmations provides sufficient finality
- MPC MAY use a configurable threshold (e.g., 3 for low-value, 6+ for high-value)

**Success callback payload:**

```text
confirm_success {
  session_id:     [u8; 32]
  spending_txid:  [u8; 32]      // Bitcoin txid that spent the UTXO
  block_hash:     [u8; 32]      // Block containing the transaction
  block_height:   u64           // For reference/logging
  confirmations:  u32           // Number of confirmations at callback time
  signature:      Signature     // MPC attestation over all fields
}
```

---

### Failure Conditions (IMPOSSIBLE)

A session is marked **IMPOSSIBLE** when the UTXO can no longer be spent by the session's intended transaction. This triggers a refund of reserved balance.

| Condition | How Detected | Example |
|-----------|--------------|---------|
| **UTXO spent by different transaction** | `actual_hashOutputs != session.hashOutputs` | Another session's tx confirmed first; user broadcast different tx |
| **UTXO spent with different outputs** | Outputs don't match expected | User manually spent UTXO outside the system |
| **UTXO burned** | Output is OP_RETURN or unspendable | Rare edge case |

**Important:** MPC only reports IMPOSSIBLE after **6 confirmations** of the conflicting transaction. This prevents false positives from temporary chain reorganizations.

**What is NOT a failure condition:**

| Situation | Status | Reason |
|-----------|--------|--------|
| UTXO unspent for a long time | Still ACTIVE | No time-based expiration; user may broadcast later |
| Transaction in mempool but unconfirmed | Still ACTIVE | Wait for confirmations |
| Low fee causing delayed confirmation | Still ACTIVE | Eventually confirms or gets evicted |
| Transaction evicted from mempool | Still ACTIVE | User can rebroadcast; UTXO still unspent |

**Failure callback payload:**

```text
confirm_impossible {
  session_id:       [u8; 32]
  spending_txid:    [u8; 32]      // Bitcoin txid that invalidated this session
  block_hash:       [u8; 32]      // Block containing the conflicting tx
  block_height:     u64
  confirmations:    u32
  reason:           FailureReason // Enum: UtxoSpentElsewhere, OutputsMismatch, etc.
  signature:        Signature     // MPC attestation over all fields
}
```

**FailureReason enum:**

```text
enum FailureReason {
  UtxoSpentElsewhere,    // UTXO spent by tx with different hashOutputs
  OutputsMismatch,       // Outputs don't match session expectations
  UtxoBurned,            // UTXO sent to unspendable output (OP_RETURN)
}
```

---

### Multi-Session Outpoint Resolution

When multiple sessions reference the same outpoint, MPC must resolve each session individually:

```text
Example:
  Session A: expects hashOutputs = 0xabc...
  Session B: expects hashOutputs = 0xdef...
  Both reference UTXO X

When UTXO X is spent:
  actual_hashOutputs = sha256d(spending_tx.outputs)

  If actual_hashOutputs == 0xabc...:
    Session A → SUCCESS (balance finalized)
    Session B → IMPOSSIBLE (balance refunded)

  If actual_hashOutputs == 0xdef...:
    Session A → IMPOSSIBLE (balance refunded)
    Session B → SUCCESS (balance finalized)

  If actual_hashOutputs == 0x999... (neither):
    Session A → IMPOSSIBLE (balance refunded)
    Session B → IMPOSSIBLE (balance refunded)
```

---

### DEX Callback Handling

On receiving a confirmation callback:

1. **Verify MPC signature** — Recover signer address, compare against known MPC public key.
2. **Verify confirmations** — Ensure `confirmations >= 6` (or configured threshold).
3. **Load session** — Fetch session PDA by `session_id`.
4. **Validate session state** — Must be ACTIVE; reject duplicate callbacks.
5. **For SUCCESS:**
   - Verify `sha256d(actual_outputs) == session.hashOutputs` (defense in depth)
   - Finalize balance: `reserved_balance → permanently_spent`
   - Mark session COMPLETED
6. **For IMPOSSIBLE:**
   - Refund balance: `reserved_balance → available_balance`
   - Mark session FAILED
7. **Emit event** — For indexers and user notification.

---

## Example Flow (Withdrawal)

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
  │                          │ authorized += amount_0 │                     │
  │                          │ CPI -> sign payload    ├────────────────────►│
  │◄──────── signature_0 ────┤                        │                     │
  │                          │                        │                     │
  │ sign_input(outpoint_1)   │                        │                     │
  ├─────────────────────────►│ check: sum <= expected │                     │
  │                          │ CPI -> sign payload    ├────────────────────►│
  │◄──────── signature_1 ────┤                        │                     │
  │                          │                        │                     │
  │ assemble + broadcast BTC tx ───────────────────────────────────────────►│
  │                          │                        │                     │
  │                          │                        │ observe UTXO spent  │
  │                          │                        │ verify outputs      │
  │                          │◄─── confirm_success(session, txid) + sig ────┤
  │                          │ verify MPC signature   │                     │
  │                          │ finalize balance       │                     │
  │                          │ close session          │                     │
```

---

## Security Analysis

### Attack Vectors and Mitigations

| Attack | Mitigation | Status |
|--------|------------|--------|
| Steal change by directing to user's address | DEX validates `outputs[1].script == VAULT_SCRIPT_PUBKEY` | ✅ Mitigated |
| Inflate fee to drain vault to miners | DEX enforces `authorized_input_total ≤ expected_input_total` | ✅ Mitigated |
| Race condition: withdraw balance after session | Balance **reserved** at session creation, not just checked | ✅ Mitigated |
| Session ID collision/hijacking | `session_id` derived from commitments, never user-provided | ✅ Mitigated |
| Split transaction across sessions | BIP143 commitments force same `session_id` for same tx | ✅ Impossible |
| Lie about input amounts | BIP143 commits to amount; wrong amount = invalid signature | ✅ Self-defeating |
| Lie about hashPrevouts/hashSequence | Wrong commitments = invalid signatures | ✅ Self-defeating |
| Double-sign same outpoint across sessions | Bitcoin consensus prevents double-spend; losing session refunded | ✅ Safe by design |
| MPC as signing oracle for arbitrary digests | MPC only accepts structured payload, constructs preimage itself | ✅ Mitigated |
| Manipulate outputs after session creation | `hashOutputs` pinned at creation; signatures commit to it | ✅ Cryptographic binding |

---

### Detailed Attack Analysis

#### Attack 1: Steal Change Output

**Goal:** User directs vault change to their own address, extracting more value than they paid for.

**Attack scenario:**

```text
User's balance: 10 BTC

User creates session:
  Output 0: 5 BTC → user's withdrawal address
  Output 1: 4 BTC → user's SECOND address (fake "vault change")
  declared_fee: 1 BTC

  user_cost = 5 + 1 = 6 BTC (reserved from balance)

User signs 10 BTC of inputs
Transaction confirms:
  User receives: 5 + 4 = 9 BTC
  User paid: 6 BTC

  Theft: 3 BTC
```

**Mitigation:**

```text
require!(outputs[1].script == VAULT_SCRIPT_PUBKEY, "Change must go to vault")
```

DEX validates that the change output scriptPubKey matches a known vault address. Session creation fails if this check fails.

**Status:** ✅ MITIGATED

---

#### Attack 2: Fee Inflation (Drain to Miners)

**Goal:** User signs more inputs than declared, excess goes to miners as implicit fee.

**Attack scenario:**

```text
User creates session:
  Output 0: 5 BTC → user
  Output 1: 4 BTC → vault change
  declared_fee: 1 BTC
  expected_input_total = 5 + 4 + 1 = 10 BTC
  user_cost = 5 + 1 = 6 BTC (reserved)

Attack: User signs 15 BTC of inputs instead of 10 BTC

Transaction on Bitcoin:
  Inputs: 15 BTC
  Outputs: 5 + 4 = 9 BTC
  Implicit fee: 15 - 9 = 6 BTC (goes to miners!)

Result:
  User paid: 6 BTC
  Vault lost: 15 - 4 = 11 BTC
  Theft: 5 BTC (vault lost 11, user only paid 6)
```

**Mitigation:**

```text
// At each sign_input call:
require!(authorized_input_total + amount_sats <= expected_input_total,
         "Input total exceeds declared fee + outputs")
```

After signing 10 BTC of inputs, the accumulation bound blocks further signing.

**Status:** ✅ MITIGATED

---

#### Attack 3: Race Condition (Balance Drain)

**Goal:** Create session, then transfer balance elsewhere before signing completes.

**Attack scenario:**

```text
1. User has 10 BTC balance
2. User creates session (balance CHECK passes: 10 >= 6)
3. User transfers 10 BTC to another account
4. User completes signing
5. Transaction confirms
6. Vault lost 10 BTC, user's balance was 0

Result: Vault drained without backing funds
```

**Mitigation:**

Balance is **reserved** (not just checked) at session creation:

```text
require!(user.available_balance >= user_cost)
user.available_balance -= user_cost    // Locked!
user.reserved_balance  += user_cost
```

Step 3 would fail because `available_balance` is now 4 BTC (10 - 6 reserved).

**Status:** ✅ MITIGATED

---

#### Attack 4: Session Splitting

**Goal:** Split a multi-input transaction across sessions to bypass accumulation bound.

**Attack scenario:**

```text
Transaction needs 3 inputs (10 BTC each = 30 BTC total)
User wants: 25 BTC output, 4 BTC change, 1 BTC fee

Instead of one session (would require 26 BTC reserved):
  User creates 3 sessions, each signing 1 input
  Each session has smaller accumulation bound
  Total reserved: less than 26 BTC?
```

**Why this FAILS:**

For signatures to combine into a valid Bitcoin transaction:

```text
All signatures must commit to:
  hashPrevouts = sha256d(input_0 || input_1 || input_2)  // ALL inputs
```

Session ID derivation:

```text
session_id = sha256(hashPrevouts || hashSequence || hashOutputs || user_pubkey)
```

**Case A: User provides correct hashPrevouts (all 3 inputs)**

```text
Session 1: session_id = sha256(H_all_inputs || ... || user) = X
Session 2: session_id = sha256(H_all_inputs || ... || user) = X  // SAME!
Session 3: session_id = sha256(H_all_inputs || ... || user) = X  // SAME!
```

All three "sessions" are the same session. Accumulation bound applies to total.

**Case B: User lies about hashPrevouts (different per session)**

```text
Session 1: hashPrevouts = sha256d(input_0 only)  → sig_0 commits to this
Session 2: hashPrevouts = sha256d(input_1 only)  → sig_1 commits to this
Session 3: hashPrevouts = sha256d(input_2 only)  → sig_2 commits to this
```

Actual transaction needs:

```text
hashPrevouts = sha256d(input_0 || input_1 || input_2)
```

None of the signatures are valid! They each commit to different (fictional) transactions.

**Status:** ✅ IMPOSSIBLE (cryptographic structure prevents it)

---

#### Attack 5: Lie About Input Amounts

**Goal:** Claim UTXOs are worth less than actual value to reduce reserved balance.

**Attack scenario:**

```text
Actual UTXO values: 10 BTC each
User claims: 3 BTC each

Session:
  hashPrevouts includes 3 UTXOs
  User claims total inputs = 9 BTC
  Outputs: 5 BTC user + 3 BTC change + 1 BTC fee = 9 BTC
  user_cost = 5 + 1 = 6 BTC (reserved)

User signs with claimed amounts (3 BTC each)
```

**Why this FAILS:**

BIP143 sighash preimage includes `amount` field (#6):

```text
MPC builds preimage with amount = 3 BTC (user's claim)
Actual UTXO on Bitcoin = 10 BTC

Sighash = sha256d(preimage with amount=3BTC)
Signature is INVALID on Bitcoin network!
```

Bitcoin nodes verify the amount in the sighash matches the actual UTXO value. Mismatched amounts produce invalid signatures.

**Result:** User wasted gas, got unusable signatures. Vault is fine.

**Status:** ✅ SELF-DEFEATING (user only hurts themselves)

---

#### Attack 6: Double-Sign Outpoint Across Sessions

**Goal:** Create multiple sessions using same UTXO, extract value multiple times.

**Attack scenario:**

```text
UTXO X = 10 BTC

Session A: UTXO X → 5 BTC user + 4 BTC vault + 1 BTC fee
           user_cost_A = 6 BTC reserved

Session B: UTXO X → 8 BTC user + 1 BTC vault + 1 BTC fee
           user_cost_B = 9 BTC reserved

Total reserved: 15 BTC

User signs both, broadcasts both...
```

**Why this is SAFE:**

1. **Bitcoin consensus:** Only ONE transaction spending UTXO X can confirm
2. **MPC observation:** When UTXO X is spent:
   - If by Session A's tx → Session A SUCCESS, Session B IMPOSSIBLE (refund 9 BTC)
   - If by Session B's tx → Session B SUCCESS, Session A IMPOSSIBLE (refund 6 BTC)

```text
Maximum extraction:
  Session A succeeds: user gets 5 BTC, paid 6 BTC → vault OK
  Session B refunded: 9 BTC returned to available_balance

OR

  Session B succeeds: user gets 8 BTC, paid 9 BTC → vault OK
  Session A refunded: 6 BTC returned to available_balance
```

**Result:** User over-reserved capital (inefficient for them), but vault invariant holds.

**Status:** ✅ SAFE BY DESIGN

---

#### Attack 7: MPC as Arbitrary Signing Oracle

**Goal:** Get MPC to sign arbitrary digest for unauthorized transaction.

**Attack scenario:**

```text
Attacker computes sighash for malicious transaction:
  malicious_digest = sha256d(evil_preimage)

Attacker somehow submits malicious_digest to MPC
MPC signs it
Attacker now has valid signature for unauthorized tx
```

**Mitigation:**

MPC **never** signs raw digests. It only accepts structured `SignInputPayload`:

```text
SignInputPayload {
  hashPrevouts, hashSequence, hashOutputs,  // Commitments
  outpoint, amount, sequence, scriptCode,   // Per-input data
  nVersion, nLockTime, sighashType          // Constants
}
```

MPC **constructs** the BIP143 preimage itself from these fields, then computes sighash:

```text
preimage = build_bip143_preimage(payload)
sighash = sha256d(preimage)
signature = ecdsa_sign(key, sighash)
```

There is no code path to sign an arbitrary 32-byte value.

**Status:** ✅ MITIGATED (by design)

---

#### Attack 8: Manipulate Outputs After Session Creation

**Goal:** Create session with valid outputs, then change outputs before signing.

**Attack scenario:**

```text
Session creation:
  outputs = [5 BTC user, 4 BTC vault]
  hashOutputs = sha256d(serialize(outputs)) = 0xabc...
  user_cost = 6 BTC reserved

Before signing, user wants to change to:
  outputs = [8 BTC user, 1 BTC vault]  // More for user!
```

**Why this FAILS:**

1. `hashOutputs` is pinned at session creation and stored in session PDA
2. Every signature commits to `hashOutputs` via BIP143 preimage
3. User cannot change stored `hashOutputs`
4. If user builds transaction with different outputs:
   - `sha256d(new_outputs) != session.hashOutputs`
   - Signatures are invalid for the new transaction

**Status:** ✅ CRYPTOGRAPHIC BINDING

---

### Core Invariant Proof

```text
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

## Conclusion

The Parallel UTXO Signing Architecture is **secure against its stated threat model**.

The core invariant `vault_value_spent ≤ user_balance_reserved` is mathematically guaranteed by three interlocking mechanisms:

1. **Balance reservation** — locks funds at session creation
2. **Input accumulation bound** — caps total signable value
3. **Change address validation** — ensures vault receives its change

Each mechanism is necessary; removing any one breaks the invariant. Together, they form a complete defense against user theft and vault drain.

**Key design properties:**

- **No time-based expiration:** Sessions resolve based on Bitcoin state (success or impossible).
- **Outpoint reuse allowed:** Multiple sessions can reference the same UTXO; Bitcoin consensus ensures only one succeeds, others are refunded.
- **Session splitting impossible:** BIP143 cryptographic structure forces all inputs of one transaction into one session via the `session_id` derivation.

**Assumption:** MPC is honest (or Byzantine-fault-tolerant with threshold cryptography). If MPC is fully compromised, it could sign arbitrary transactions regardless of DEX constraints.

---
---

# Deposit Flow

## Goal

Enable users to transfer Bitcoin from their **unique derived address** (MPC-controlled, per-user) to the **main vault address**, crediting their Solana balance upon confirmation.

```text
External World → User's Derived Address → Vault Address → Solana Balance Credit
                 (MPC controlled)         (MPC controlled)
```

The same parallel UTXO signing architecture applies—users may have multiple UTXOs at their derived address that need consolidation into a single deposit transaction.

---

## The Fundamental Asymmetry: Deposit vs Withdrawal

| Aspect | Withdrawal | Deposit |
|--------|------------|---------|
| Source of funds | Vault (shared pool) | User's derived address (per-user) |
| Funds already credited on Solana? | **YES** | **NO** |
| Who loses if change is misdirected? | Vault (theft) | User only (their choice) |
| Who loses if fee is inflated? | Vault (drained to miners) | User only (less credit) |
| Balance reservation required? | **YES** (critical) | **NO** |
| Change validation required? | **YES** (critical) | **NO** |
| Accumulation bound required? | **YES** (critical) | **NO** |
| Input ownership validation required? | **NO** (vault inputs) | **YES** (critical) |

**Key insight:** At the user's derived address, the BTC exists but is **not yet credited** to their Solana balance. The credit only happens when funds arrive at the vault. Until then, the user is spending "their own uncredited money."

---

## Deposit Threat Model

**Primary invariant:** A user must not be able to credit their Solana balance with more than they actually deposited to the vault.

```text
solana_balance_credited ≤ btc_actually_received_by_vault
```

**Secondary invariant:** A user must not be able to spend funds from another user's derived address.

```text
inputs_spent ⊆ user's_own_derived_utxos
```

**Not security concerns (user's problem):**

- User sends less than intended (partial deposit)
- User overpays fees (less credit)
- User sends change to external address (their choice)
- Transaction doesn't confirm (no credit given)

---

## Deposit Security Model

### Why the Invariants Hold

**Primary invariant proof:**

```text
At deposit confirmation:
  credit_amount = sum(outputs where script == VAULT_SCRIPT_PUBKEY)

The credit is derived from ACTUAL vault outputs on Bitcoin,
not from user claims or session parameters.

Therefore: credit ≤ actual_vault_receipt  (always, by construction)
```

**Secondary invariant proof:**

```text
At sign_deposit_input:
  DEX validates: scriptCode.derives_from(user_derived_script)

At Bitcoin broadcast (if DEX validation bypassed):
  BIP143 sighash commits to scriptCode in preimage
  Actual UTXO has different scriptPubKey → sighash mismatch → invalid signature

Therefore: only user's own UTXOs produce valid signatures  ∎
```

### Two Mechanisms Enforce Security

| Mechanism | What it prevents | Why it's required |
|-----------|------------------|-------------------|
| **Input ownership validation** | User stealing from other users' derived addresses | Without this, user A could spend user B's UTXOs |
| **Credit from actual output** | User claiming more than deposited | Without this, user could claim arbitrary credit |

---

## Deposit Security Invariants

### 1. Input Ownership Validation (CRITICAL)

All inputs in a deposit transaction **must** belong to the requesting user's derived address path.

**DEX-level validation:**

```text
// At sign_deposit_input:
user_derived_script = derive_scriptPubKey(MPC_root, user.derivation_path)
require!(scriptCode.derives_from(user_derived_script),
         "Input not from user's derived address")
```

**scriptCode validation for SegWit variants:**

```text
For P2WPKH:
  scriptPubKey = OP_0 <20-byte-pubkey-hash>
  scriptCode   = OP_DUP OP_HASH160 <20-byte-pubkey-hash> OP_EQUALVERIFY OP_CHECKSIG
  Validation:  Extract hash from scriptCode, compare to HASH160(derived_pubkey)

For P2WSH:
  scriptPubKey = OP_0 <32-byte-script-hash>
  scriptCode   = <actual witness script>
  Validation:  SHA256(scriptCode) must equal script-hash, and script must be vault-controlled

For P2SH-P2WPKH (nested):
  scriptPubKey = OP_HASH160 <20-byte-script-hash> OP_EQUAL
  scriptCode   = OP_DUP OP_HASH160 <20-byte-pubkey-hash> OP_EQUALVERIFY OP_CHECKSIG
  Validation:  Same as P2WPKH, extract and compare pubkey hash
```

---

### 2. Credit Equals Actual Vault Output

The Solana balance credit **must** equal the actual Bitcoin received by the vault, not any user-provided claim.

```text
on_deposit_confirmed(session_id, spending_tx):
  vault_outputs = spending_tx.outputs.filter(o => o.script == VAULT_SCRIPT_PUBKEY)
  credit_amount = sum(vault_outputs.map(o => o.amount))

  user.solana_balance += credit_amount
```

---

### 3. Confirmation Threshold (6 Blocks)

Same as withdrawal—credit only after 6 confirmations to prevent reorg-based attacks.

---

### 4. No Double-Credit

Bitcoin consensus prevents double-spending the same UTXO. Explicit tracking provides defense in depth:

```text
for each input in confirmed_deposit:
  require!(!deposited_utxos.contains(input.outpoint))
  deposited_utxos.insert(input.outpoint)
```

---

## Deposit Session Flow

### 1) Create Deposit Session

```text
create_deposit_session {
  hashPrevouts: [u8; 32],
  hashSequence: [u8; 32],
  outputs: [
    { script: VAULT_SCRIPT_PUBKEY, amount: deposit_amount },
    { script: change_address,      amount: change_amount }  // Optional, any address
  ],
  nVersion:  u32,
  nLockTime: u32
}
```

**DEX validation:**

```text
// 1. Verify at least one output goes to vault
vault_output = outputs.find(o => o.script == VAULT_SCRIPT_PUBKEY)
require!(vault_output.is_some(), "No vault output in deposit")

// 2. Compute hashOutputs and derive session ID
hashOutputs = sha256d(serialize(outputs))
session_id = sha256(hashPrevouts || hashSequence || hashOutputs || user_pubkey)

// 3. Create session (NO balance reservation needed)
```

### 2) Sign Deposit Input

```text
sign_deposit_input(session_id, outpoint, amount_sats, sequence, scriptCode)
```

**DEX validation:**

```text
// 1. Load session and verify ownership
session = load_session(session_id)
require!(session.user == caller)

// 2. Validate input belongs to user's derived path (CRITICAL)
user_derived_script = derive_scriptPubKey(MPC_root, user.derivation_path)
require!(scriptCode.derives_from(user_derived_script))

// 3. NO accumulation bound check needed

// 4. Construct signing payload and CPI to MPC
```

### 3) Deposit Confirmation

```text
confirm_deposit(session_id, spending_txid, actual_outputs, signature)
```

**DEX handling:**

```text
// 1. Verify MPC signature
// 2. Verify 6+ confirmations

// 3. Calculate actual deposit from Bitcoin state
actual_vault_outputs = actual_outputs.filter(o => o.script == VAULT_SCRIPT_PUBKEY)
actual_deposit = sum(actual_vault_outputs.map(o => o.amount))

// 4. Credit user (based on ACTUAL receipt, not session expectation)
user.solana_balance += actual_deposit

// 5. Track deposited UTXOs and close session
for input in session.inputs:
  deposited_utxos.insert(input.outpoint)
session.status = Completed
```

---

## Deposit Attack Analysis

### Attack 1: Steal From Other Users' Derived Addresses

**Goal:** Spend UTXOs belonging to another user's derived address.

**Scenario:**

```text
User A's derived address: has 10 BTC (UTXO X)
User B (attacker): wants to steal User A's funds

User B creates deposit session and calls sign_deposit_input:
  outpoint: UTXO X (User A's)
  scriptCode: User A's scriptPubKey
  amount: 10 BTC
```

**Why this fails - Layer 1 (DEX validation):**

```text
user_derived_script = derive_scriptPubKey(MPC_root, user_B.derivation_path)

// User B's derived script ≠ User A's scriptCode
require!(scriptCode.derives_from(user_derived_script))  // FAILS
```

**Why this fails - Layer 2 (BIP143, if DEX bypassed):**

If attacker somehow bypasses DEX and provides their OWN scriptCode to pass validation:

```text
User B provides:
  outpoint: UTXO X (User A's UTXO)
  scriptCode: User B's scriptPubKey (passes DEX check!)

MPC signs with User B's scriptCode in BIP143 preimage.

On Bitcoin broadcast:
  Bitcoin nodes compute sighash using ACTUAL UTXO's scriptPubKey (User A's)
  MPC signature was computed using User B's scriptCode
  Sighash mismatch → signature INVALID → transaction REJECTED
```

BIP143's design ensures the scriptCode in the preimage MUST match the actual scriptPubKey being spent.

**Status:** ✅ MITIGATED (two-layer defense: DEX validation + BIP143 cryptographic binding)

---

### Attack 2: Claim More Credit Than Deposited

**Goal:** Get Solana balance credit exceeding actual vault receipt.

**Scenario:**

```text
User creates deposit session:
  outputs: [{ vault, 100 BTC }]  // Claims 100 BTC

User actually broadcasts transaction:
  Output: 1 BTC to vault
  Output: 99 BTC to user's external address
```

**Why this fails:**

```text
// At confirmation, DEX observes ACTUAL Bitcoin outputs:
actual_deposit = sum(confirmed_tx.outputs
                     .filter(o => o.script == VAULT_SCRIPT_PUBKEY)
                     .map(o => o.amount))
               = 1 BTC

user.balance += actual_deposit  // Credits 1 BTC, not 100 BTC
```

Credit is based on observation, not claims.

**Status:** ✅ MITIGATED (credit from observation)

---

### Attack 3: Double-Credit via Session Collision

**Goal:** Create two sessions for same UTXO, get credited twice.

**Scenario:**

```text
Session A: UTXO X → 5 BTC to vault (hashOutputs = 0xabc...)
Session B: UTXO X → 5 BTC to vault (same inputs, same outputs)
```

**Why this fails:**

```text
session_id = sha256(hashPrevouts || hashSequence || hashOutputs || user_pubkey)

Both sessions have identical:
  - hashPrevouts (same inputs)
  - hashSequence (same sequences)
  - hashOutputs (same outputs)
  - user_pubkey (same user)

Therefore: session_id_A == session_id_B

Sessions collapse into ONE session. Only one credit possible.
```

**Status:** ✅ MITIGATED (cryptographic session identity)

---

### Attack 4: Double-Credit via Different Outputs

**Goal:** Create two sessions for same UTXO with different outputs, get credited for both.

**Scenario:**

```text
Session A: UTXO X → 5 BTC to vault (hashOutputs = 0xabc...)
Session B: UTXO X → 8 BTC to vault (hashOutputs = 0xdef...)

User signs both sessions, broadcasts one transaction.
```

**Why this fails:**

```text
Only ONE transaction spending UTXO X can confirm (Bitcoin consensus).

When UTXO X is spent:
  actual_hashOutputs = sha256d(spending_tx.outputs)

  If actual_hashOutputs == 0xabc...:
    Session A → SUCCESS (credit 5 BTC)
    Session B → IMPOSSIBLE (UTXO spent differently, no credit)

  If actual_hashOutputs == 0xdef...:
    Session A → IMPOSSIBLE (no credit)
    Session B → SUCCESS (credit 8 BTC)
```

Only the matching session gets credited. Bitcoin consensus prevents double-spend.

**Status:** ✅ MITIGATED (Bitcoin consensus + hashOutputs matching)

---

### Attack 5: Replay Confirmation Callback

**Goal:** Replay old deposit confirmation to get credited again.

**Scenario:**

```text
1. User deposits 10 BTC, session confirmed, credited
2. Attacker replays confirm_deposit(session_id, ...) callback
3. Attacker expects another 10 BTC credit
```

**Why this fails:**

```text
// At first confirmation:
session.status = Completed

// At replay attempt:
require!(session.status == Active)  // FAILS - session already completed

// Additionally, deposited UTXOs are tracked:
require!(!deposited_utxos.contains(outpoint))  // FAILS - already recorded
```

**Status:** ✅ MITIGATED (session state machine + UTXO tracking)

---

### Attack 6: Front-Running / MEV

**Goal:** Front-run user's deposit transaction to steal funds.

**Scenario:**

```text
Attacker sees user's deposit transaction in Bitcoin mempool.
Attacker tries to front-run with their own transaction spending the same UTXO.
```

**Why this fails:**

```text
The deposit transaction spends from user's derived address.
Only the user (via MPC with their derivation path) can produce valid signatures.
Attacker cannot sign for user's derived address.
```

**Status:** ✅ NOT POSSIBLE (MPC key derivation)

---

### Non-Attacks (User's Choice, Not Threats)

The following scenarios are explicitly **NOT security concerns**—they represent user choices that only affect the user:

| Scenario | Outcome | Why it's not a threat |
|----------|---------|----------------------|
| **Partial deposit** | User deposits 5 BTC of 10 BTC, keeps 5 BTC as change | Credit = 5 BTC (what reached vault). User chose this. |
| **Fee overpayment** | User pays 8 BTC fee on 10 BTC input, 2 BTC to vault | Credit = 2 BTC. Vault received 2 BTC, credited 2 BTC. User's loss. |
| **Redirect to external** | User sends all funds to external address, none to vault | Credit = 0 BTC. User moved their own uncredited money. |

In all cases: `vault_credit == vault_receipt`. The invariant holds.

---

## Deposit Conclusion

The deposit flow is **significantly simpler** than withdrawal because the user is converting **uncredited external value** into **credited internal balance**.

**Two mechanisms provide complete security:**

1. **Input ownership validation** — enforced by DEX + BIP143 cryptographic binding
2. **Credit from observation** — credit equals actual vault receipt, not user claims

**Why deposit doesn't need withdrawal's protections:**

| Mechanism | Withdrawal | Deposit | Reason |
|-----------|------------|---------|--------|
| Balance reservation | ✅ Required | ❌ Not needed | No pre-existing balance to protect |
| Accumulation bound | ✅ Required | ❌ Not needed | Over-fee only hurts user |
| Change validation | ✅ Required | ❌ Not needed | User's uncredited funds |

**The only critical validation** is input ownership—ensuring users can only spend from their own derived addresses.
