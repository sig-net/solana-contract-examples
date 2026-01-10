# Parallel UTXO Signing Architecture

> **Status:** Proposal
> **Last Updated:** 2024-12

---

## 1. Overview

### 1.1 Problem Statement

Solana transactions are limited to approximately 1,232 bytes. Bitcoin transaction data scales linearly with the number of inputs, causing full Bitcoin transaction or PSBT data transmitted through Solana to quickly exceed this limit (typically at 3-5 inputs).

**Objective:** Enable unlimited UTXO inputs for vault consolidation and large withdrawals by signing inputs in parallel across multiple Solana transactions.

### 1.2 Proposed Solution

Leverage BIP143's SegWit v0 sighash structure to sign each input independently in separate Solana transactions, while ensuring all signatures commit to the same Bitcoin inputs and outputs.

**Key insight:** In BIP143 with `SIGHASH_ALL`, the sighash preimage contains three transaction-wide 32-byte commitments that remain constant for all inputs:

- `hashPrevouts` — commits to all input outpoints
- `hashSequence` — commits to all input sequences
- `hashOutputs` — commits to all outputs

Instead of transmitting a full PSBT, the system passes only these commitments plus per-input fields.

### 1.3 Scope and Assumptions

- **Bitcoin inputs:** SegWit v0 spends using BIP143 and ECDSA signatures with `SIGHASH_ALL` (P2WPKH, P2WSH, or nested SegWit).
- **Outputs:** Fixed structure of two outputs: user withdrawal and vault change.
- **MPC signing request:** MPC receives serialized per-input signing data (not a precomputed digest) and constructs the BIP143 preimage deterministically.

### 1.4 System Components

This proposal extends the existing Signet architecture:

| Component | Repository | Role |
| --------- | ---------- | ---- |
| **ChainSignatures Program** | `signet-solana-program` | Core MPC signing infrastructure (`sign`, `sign_bidirectional`, `respond`) |
| **Vault Program** | `solana-contract-examples` | BTC/ERC20 vault logic (`deposit_btc`, `withdraw_btc`, etc.) |
| **MPC Network** | `mpc` | Threshold ECDSA signing (5-of-8), Bitcoin observation |

The Vault Program issues CPI calls to ChainSignatures for signature requests.

---

## 2. Architecture

### 2.1 Trust Architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│  VAULT PROGRAM (solana-contract-examples)                        │
│                                                                  │
│  Responsibilities:                                               │
│  • Derive session_id from commitment hashes (never user-provided)│
│  • Validate outputs: user withdrawal + vault change scripts      │
│  • Compute/store hashOutputs from canonical output serialization │
│  • Reserve user balance (fee + withdrawal) at session creation   │
│  • Enforce input accumulation bound: sum(inputs) <= expected     │
│  • Track session state via WithdrawSession PDA                   │
│  • CPI to ChainSignatures program for signing                    │
└───────────────────────────────┬──────────────────────────────────┘
                                │ CPI (only if verification passes)
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│  CHAIN SIGNATURES PROGRAM (signet-solana-program)                │
│                                                                  │
│  • Emits SignatureRequestedEvent for MPC indexer                 │
│  • Receives respond() callbacks with ECDSA signatures            │
│  • Emits SignatureRespondedEvent for client polling              │
└───────────────────────────────┬──────────────────────────────────┘
                                │ Event observation
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│  MPC NETWORK (mpc)                                               │
│                                                                  │
│  • Indexes SignatureRequestedEvent from Solana                   │
│  • Receives serialized per-input signing data                    │
│  • Deterministically constructs BIP143 preimage + signs sighash  │
│  • Observes Bitcoin for spends and reports confirmed results     │
│  • Reports failure ONLY when UTXO deemed impossible to spend     │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Technical Foundation: BIP143 Sighash Structure

### 3.1 Preimage Format

For each input `i`, the BIP143 sighash preimage is structured as follows:

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

### 3.2 Shared Hash Computation

```text
hashPrevouts = SHA256(SHA256(outpoint[0] || outpoint[1] || ... || outpoint[N]))
               where outpoint = txid(32 LE) || vout(4 LE)

hashSequence = SHA256(SHA256(sequence[0] || sequence[1] || ... || sequence[N]))

hashOutputs  = SHA256(SHA256(output[0] || output[1] || ...))
               where output = value(8 LE) || scriptPubKey_len(varint) || scriptPubKey
```

### 3.3 Why Parallel Signing Works

Once `hashPrevouts`, `hashSequence`, and `hashOutputs` are fixed:

- Each signature commits to the entire transaction (inputs + outputs) via these hashes.
- Each signature can be computed independently, requiring only its own outpoint, script, amount, and sequence plus the shared hashes.
- Signatures cannot be combined across different transactions because different input/output sets produce different commitments and therefore different sighashes.

### 3.4 Session Splitting Prevention

An attacker might attempt to split a multi-input transaction across separate sessions to bypass the accumulation bound. This attack is cryptographically impossible due to BIP143's structure:

- All signatures must commit to the same `hashPrevouts` (hash of ALL inputs)
- The `session_id` is derived from `hashPrevouts || hashSequence || hashOutputs || user_pubkey`
- Identical commitments produce identical session IDs (accumulation bound applies)
- Different commitments produce incompatible signatures (invalid on Bitcoin)

**See [Section 8.4: Attack 4 - Session Splitting](#84-attack-4-session-splitting) for the formal proof.**

---

## 4. Security Framework

### 4.1 Threat Model

**Primary invariant:** A user must not be able to extract vault value beyond their reserved balance.

```text
vault_value_spent ≤ user_balance_reserved
```

Invalid signatures, failed broadcasts, and excess transaction costs are the user's responsibility, not security concerns for the vault.

### 4.2 Security Model

The vault can never lose more than the user has reserved:

```text
vault_loss ≤ user_cost  (always)
```

This follows from the constraint `authorized_input_total ≤ expected_input_total` and the requirement that `vault_change` returns to the vault. **See [Section 8.5: Core Invariant Proof](#85-core-invariant-proof) for the formal derivation.**

### 4.3 Three Enforcement Mechanisms

| Mechanism | What it prevents | Why it is required |
| --------- | ---------------- | ------------------ |
| **Balance reservation** | User creating sessions exceeding their balance | Without this, user could sign without funds to back it |
| **Input accumulation bound** | User signing more inputs than `sum(outputs) + fee` | Without this, excess inputs become unaccounted fee (vault drain) |
| **Change address validation** | User claiming change while only paying `user_out + fee` | Without this, the invariant fails |

**Removing any single mechanism breaks the invariant.**

### 4.4 Change Address Validation Requirement

Change address validation is not merely a best practice—it is mathematically essential for the invariant to hold.

The `user_cost` formula is `user_out + declared_fee`. It does not include `vault_change` because that value is expected to return to the vault. If a user could direct the change output to their own address, they would extract `vault_change` worth of value without paying for it, breaking the invariant.

**See [Section 8.1: Attack 1 - Steal Change Output](#81-attack-1-steal-change-output) for a detailed example.**

### 4.5 Control and Enforcement Summary

| User Controls | Vault Enforces | Result |
| ------------- | -------------- | ------ |
| Withdrawal amount | Change output → vault address | User cannot steal change |
| Fee amount | `sum(inputs) ≤ outputs + declared_fee` | User cannot inflate fees |
| Which inputs to sign | Balance reserved at session creation | User cannot outrun their balance |
| Session ID | Derived from commitments | User cannot hijack sessions |
| Input amounts | BIP143 commits to amount | User cannot lie (self-defeating) |

---

## 5. Withdrawal Protocol: Security Invariants

### 5.1 Session ID Derivation

The `session_id` **must** be deterministically derived from the transaction commitment hashes:

```text
session_id = sha256(hashPrevouts || hashSequence || hashOutputs || user_pubkey)
```

**Rationale:**

- **Prevents session confusion attacks:** A user-provided session ID could collide with or reference another user's session.
- **Ensures deterministic verification:** Given the same commitments and user, the session ID is always identical.
- **Prevents replay across sessions:** Each unique transaction shape produces a unique session ID.
- **Idempotent session creation:** If a user calls `create_withdraw_session` twice with identical parameters, they receive the same session ID.
- **Enforces transaction integrity:** This derivation makes session splitting attacks impossible.

**Implementation note:** The session PDA seed should include this derived `session_id`, making it impossible to create conflicting sessions.

---

### 5.2 Explicit Fee Declaration with Balance Reservation

The session **must** include an explicit `declared_fee` amount. Balance is **reserved** (not merely checked) at session creation, and input accumulation is strictly bounded.

**Session creation parameters:**

```text
create_withdraw_session {
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

**Vault computes and stores:**

```text
sum_outputs          = user_out_sats + vault_change_sats
expected_input_total = sum_outputs + declared_fee
user_cost            = user_out_sats + declared_fee   // what user pays
```

**Balance reservation (critical):**

At session creation, the Vault **immediately reserves** `user_cost` from the user's available balance:

```text
require!(user.available_balance >= user_cost)
user.available_balance -= user_cost
user.reserved_balance  += user_cost
```

This prevents race conditions where a user:

1. Creates session with balance = 10 BTC
2. Transfers 10 BTC to another account
3. Completes signing with 0 BTC backing

With reservation, step 2 fails because the balance is locked.

**Input accumulation bound (critical):**

During each `sign_withdraw_input`, the Vault enforces:

```text
require!(authorized_input_total + amount_sats <= expected_input_total,
         "Input total exceeds declared fee + outputs")

authorized_input_total += amount_sats
```

---

### 5.3 Change Output Validation

The Vault **must** validate that the change output scriptPubKey matches a known vault address.

```text
require!(outputs[0].script == user_provided_withdrawal_address)
require!(outputs[1].script == KNOWN_VAULT_SCRIPT_PUBKEY,
         "Change must go to vault")
```

**Implementation:** The Vault maintains the vault's scriptPubKey(s). Session creation fails if the change output script does not match.

---

### 5.4 Outpoint Reuse Across Sessions

Outpoints **can** be reused across multiple sessions. The Vault does not lock outpoints globally.

**Rationale:**

1. **Bitcoin consensus prevents double-spend:** Only one transaction using a given UTXO can confirm.

2. **Multiple sessions, one winner:** If a user creates sessions A and B both using UTXO X:
   - User reserves `user_cost_A` + `user_cost_B`
   - User signs in both sessions
   - User broadcasts one transaction (A)
   - Transaction A confirms → Session A succeeds
   - UTXO X is spent → Session B becomes impossible
   - Session B's reserved balance is refunded

3. **User bears optionality cost:** Creating multiple sessions for the same UTXOs locks additional capital. This represents the user's choice.

4. **No vault risk:** The invariant `vault_loss ≤ user_cost` holds per-session. Multiple sessions mean multiple reservations; only one can succeed.

**Use case:** Users may want transaction flexibility (different fee levels, different output amounts) and prepare multiple options. They pay for this optionality through locked capital.

---

### 5.5 Session Lifecycle

Sessions do **not** expire based on time. A session resolves only when its fate is determined on Bitcoin.

**Success path (transaction confirms):**

```text
1. MPC observes UTXO spent on Bitcoin
2. MPC verifies: sha256d(actual_outputs) == session.hashOutputs
3. MPC calls confirm_withdraw_success() on Solana with signed attestation
4. Vault finalizes: reserved_balance → permanently spent
5. Session closed
```

**Failure path (UTXO becomes impossible to spend):**

```text
1. MPC observes UTXO spent by a DIFFERENT transaction
   (actual_outputs hash does NOT match session.hashOutputs)
2. MPC calls confirm_withdraw_impossible() on Solana with signed attestation
3. Vault refunds: reserved_balance → available_balance
4. Session closed
```

**Rationale for no time-based expiration:**

- **Simplifies the model:** Session fate is determined by Bitcoin state, not wall-clock time.
- **No race conditions:** No timing attacks around expiration boundaries.
- **Clear resolution:** Every session eventually resolves.

**User-initiated cancellation (before any signing):**

```text
1. User calls cancel_withdraw_session()
2. Only allowed if authorized_input_total == 0 (no signatures issued)
3. Vault refunds: reserved_balance → available_balance
4. Session closed
```

**Note:** Once signatures are issued, user cannot cancel. They must either broadcast and complete, or wait for the UTXO to be spent elsewhere (which triggers refund). This prevents griefing where user obtains signatures then cancels.

---

### 5.6 MPC Signing Constraints

The Vault must only request MPC signatures using **structured** BIP143 signing payloads (fields that deterministically map to the BIP143 preimage). The system must not allow any path where a user supplies an arbitrary 32-byte digest to be signed.

**Rationale:**

If MPC signed arbitrary 32-byte digests, a malicious user could:

1. Compute their own sighash for a different transaction
2. Submit it as a payload through some other code path
3. Obtain an MPC signature for an unauthorized transaction

By requiring structured input (outpoint, amount, scriptCode, commitments), the MPC constructs the preimage internally. Signatures are only valid for the declared transaction shape.

---

### 5.7 BIP143 Amount Commitment

BIP143's sighash preimage includes the input `amount` (field #6). This is a critical security property inherited from Bitcoin's SegWit design:

- If user claims UTXO is worth 1 BTC but actual on-chain value is 5 BTC
- MPC builds preimage with `amount = 1 BTC`
- Resulting signature is invalid on Bitcoin (amount mismatch in sighash)

Users cannot misrepresent input amounts to the MPC. Incorrect amounts produce invalid signatures. This is self-defeating behavior (wasted transaction costs) rather than a vault theft vector.

This property enables trusting user-provided `amount_sats` for accounting purposes—misrepresentation only harms the user.

---

## 6. Withdrawal Protocol: Session Flow

This section defines new Vault Program instructions to enable parallel UTXO signing. These extend the existing `withdraw_btc` / `complete_withdraw_btc` pattern with session-based signing.

### 6.1 Proposed Instructions

| Instruction | Purpose | Caller |
| ----------- | ------- | ------ |
| `create_withdraw_session` | Pin tx-wide fields, reserve balance, create session PDA | User |
| `sign_withdraw_input` | Sign one BTC input, update accumulator, CPI to ChainSignatures | User |
| `cancel_withdraw_session` | Refund balance if no signatures issued | User |
| `confirm_withdraw_success` | Finalize balance after BTC confirmation | MPC |
| `confirm_withdraw_impossible` | Refund balance after conflicting spend | MPC |

### 6.2 Create Session

User calls `create_withdraw_session` with transaction parameters:

```text
create_withdraw_session {
  // Outputs (Vault validates and computes hashOutputs)
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

**Vault performs atomically:**

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

// 5. Create WithdrawSession PDA with derived session_id as seed
WithdrawSession {
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

### 6.3 Sign Input

For each Bitcoin input, user calls `sign_withdraw_input`:

```text
sign_withdraw_input(session_id, outpoint, amount_sats, sequence, scriptCode)
```

**Vault validation:**

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

**Vault constructs MPC signing payload:**

```text
SignWithdrawInputPayload {
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

### 6.4 Canonical Encoding Rules

To avoid "valid on Solana, invalid on Bitcoin" mismatches, the payload-to-preimage mapping must be exact:

- `txid` in `outpoint` is serialized **little-endian** in the preimage (reverse of RPC/display hex).
- Integers are **little-endian** (`u32`/`u64`).
- `scriptCode` is serialized as **varint length + bytes** in the preimage.
- `scriptCode` must follow BIP143 rules for the input type (e.g., P2WPKH uses P2PKH-style `scriptCode`).

---

## 7. MPC Observation and Confirmation

After signing, the MPC observes Bitcoin and reports session outcomes. The MPC acts as an oracle attesting to Bitcoin state changes.

### 7.1 Tracked Data

```text
WatchedOutpoint {
  outpoint:      (txid, vout)
  sessions:      Vec<session_id>   // Multiple sessions can reference same outpoint
  hashOutputs:   [u8; 32]          // Per-session expected outputs
}
```

### 7.2 Observation Flow

```text
1) Watch outpoint (txid:vout) for spending
2) When spent, determine spending_txid
3) Fetch spending tx, extract actual outputs
4) Compute actual_hashOutputs = sha256d(serialize(actual_outputs))
5) Wait for finality (6 confirmations)
6) For each session referencing this outpoint:
   - If actual_hashOutputs == session.hashOutputs → SUCCESS
   - If actual_hashOutputs != session.hashOutputs → IMPOSSIBLE (refund)
7) Call back to Solana with signed attestation
```

### 7.3 Success Conditions

A session is marked **SUCCESS** when all conditions are satisfied:

| Condition | Verification | Rationale |
| --------- | ------------ | --------- |
| UTXO is spent | `gettxout` returns null | Confirms transaction was mined |
| 6+ confirmations | Block depth ≥ 6 | Bitcoin finality threshold; reorg probability < 0.1% |
| Outputs match | `sha256d(actual_outputs) == session.hashOutputs` | Ensures correct withdrawal + change amounts |

**Finality threshold rationale:**

- 6 confirmations is the Bitcoin ecosystem standard for high-value transactions
- At 6 blocks deep, reversing the transaction requires sustained >50% hashrate attack
- MPC may use a configurable threshold (e.g., 3 for low-value, 6+ for high-value)

**Success callback payload:**

```text
ConfirmWithdrawSuccess {
  session_id:     [u8; 32]
  spending_txid:  [u8; 32]      // Bitcoin txid that spent the UTXO
  block_hash:     [u8; 32]      // Block containing the transaction
  block_height:   u64           // For reference/logging
  confirmations:  u32           // Number of confirmations at callback time
  signature:      Signature     // MPC attestation over all fields
}
```

### 7.4 Failure Conditions

A session is marked **IMPOSSIBLE** when the UTXO can no longer be spent by the session's intended transaction. This triggers a refund of reserved balance.

| Condition | Detection | Example |
| --------- | --------- | ------- |
| UTXO spent by different transaction | `actual_hashOutputs != session.hashOutputs` | Another session's tx confirmed first |
| UTXO spent with different outputs | Outputs don't match expected | User manually spent UTXO outside the system |
| UTXO burned | Output is OP_RETURN or unspendable | Rare edge case |

**Important:** MPC only reports IMPOSSIBLE after 6 confirmations of the conflicting transaction to prevent false positives from temporary chain reorganizations.

**Not failure conditions:**

| Situation | Status | Reason |
| --------- | ------ | ------ |
| UTXO unspent for a long time | Still ACTIVE | No time-based expiration |
| Transaction in mempool but unconfirmed | Still ACTIVE | Wait for confirmations |
| Low fee causing delayed confirmation | Still ACTIVE | Eventually confirms or gets evicted |
| Transaction evicted from mempool | Still ACTIVE | User can rebroadcast |

**Failure callback payload:**

```text
ConfirmWithdrawImpossible {
  session_id:       [u8; 32]
  spending_txid:    [u8; 32]      // Bitcoin txid that invalidated this session
  block_hash:       [u8; 32]      // Block containing the conflicting tx
  block_height:     u64
  confirmations:    u32
  reason:           FailureReason // Enum: UtxoSpentElsewhere, OutputsMismatch, etc.
  signature:        Signature     // MPC attestation over all fields
}

enum FailureReason {
  UtxoSpentElsewhere,    // UTXO spent by tx with different hashOutputs
  OutputsMismatch,       // Outputs don't match session expectations
  UtxoBurned,            // UTXO sent to unspendable output (OP_RETURN)
}
```

### 7.5 Multi-Session Outpoint Resolution

When multiple sessions reference the same outpoint, MPC resolves each session individually:

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

### 7.6 Vault Callback Handling

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

### 7.7 Example Flow

```text
User                     Vault Program                 MPC                 Bitcoin
  │                          │                        │                     │
  │ create_withdraw_session( │                        │                     │
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
  │                          │ 5. create WithdrawSession PDA                │
  │◄──────── session_id ─────┤                        │                     │
  │                          │                        │                     │
  │ sign_withdraw_input(     │                        │                     │
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
  │ sign_withdraw_input(..)  │                        │                     │
  ├─────────────────────────►│ check: sum <= expected │                     │
  │                          │ CPI -> sign payload    ├────────────────────►│
  │◄──────── signature_1 ────┤                        │                     │
  │                          │                        │                     │
  │ assemble + broadcast BTC tx ───────────────────────────────────────────►│
  │                          │                        │                     │
  │                          │                        │ observe UTXO spent  │
  │                          │                        │ verify outputs      │
  │                          │◄── confirm_withdraw_success(session) + sig ──┤
  │                          │ verify MPC signature   │                     │
  │                          │ finalize balance       │                     │
  │                          │ close session          │                     │
```

---

## 8. Security Analysis

### 8.0 Attack Vectors Summary

| Attack | Mitigation | Status |
| ------ | ---------- | ------ |
| Steal change by directing to user's address | Vault validates `outputs[1].script == VAULT_SCRIPT_PUBKEY` | ✅ Mitigated |
| Inflate fee to drain vault to miners | Vault enforces `authorized_input_total ≤ expected_input_total` | ✅ Mitigated |
| Race condition: withdraw balance after session | Balance **reserved** at session creation, not just checked | ✅ Mitigated |
| Session ID collision/hijacking | `session_id` derived from commitments, never user-provided | ✅ Mitigated |
| Split transaction across sessions | BIP143 commitments force same `session_id` for same tx | ✅ Impossible |
| Lie about input amounts | BIP143 commits to amount; wrong amount = invalid signature | ✅ Self-defeating |
| Lie about hashPrevouts/hashSequence | Wrong commitments = invalid signatures | ✅ Self-defeating |
| Double-sign same outpoint across sessions | Bitcoin consensus prevents double-spend; losing session refunded | ✅ Safe by design |
| MPC as signing oracle for arbitrary digests | MPC only accepts structured payload, constructs preimage itself | ✅ Mitigated |
| Manipulate outputs after session creation | `hashOutputs` pinned at creation; signatures commit to it | ✅ Cryptographic binding |

---

### 8.1 Attack 1: Steal Change Output

**Goal:** User directs vault change to their own address, extracting more value than paid.

**Scenario:**

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

Vault validates that the change output scriptPubKey matches a known vault address. Session creation fails if this check fails.

**Status:** ✅ MITIGATED

---

### 8.2 Attack 2: Fee Inflation

**Goal:** User signs more inputs than declared; excess goes to miners as implicit fee.

**Scenario:**

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
  Implicit fee: 15 - 9 = 6 BTC (goes to miners)

Result:
  User paid: 6 BTC
  Vault lost: 15 - 4 = 11 BTC
  Theft: 5 BTC (vault lost 11, user only paid 6)
```

**Mitigation:**

```text
require!(authorized_input_total + amount_sats <= expected_input_total,
         "Input total exceeds declared fee + outputs")
```

After signing 10 BTC of inputs, the accumulation bound blocks further signing.

**Status:** ✅ MITIGATED

---

### 8.3 Attack 3: Race Condition (Balance Drain)

**Goal:** Create session, then transfer balance elsewhere before signing completes.

**Scenario:**

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
user.available_balance -= user_cost    // Locked
user.reserved_balance  += user_cost
```

Step 3 fails because `available_balance` is now 4 BTC (10 - 6 reserved).

**Status:** ✅ MITIGATED

---

### 8.4 Attack 4: Session Splitting

**Goal:** Split a multi-input transaction across sessions to bypass accumulation bound.

**Scenario:**

```text
Transaction needs 3 inputs (10 BTC each = 30 BTC total)
User wants: 25 BTC output, 4 BTC change, 1 BTC fee

Instead of one session (would require 26 BTC reserved):
  User creates 3 sessions, each signing 1 input
  Each session has smaller accumulation bound
  Total reserved: less than 26 BTC?
```

**Why this fails:**

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
Session 2: session_id = sha256(H_all_inputs || ... || user) = X  // SAME
Session 3: session_id = sha256(H_all_inputs || ... || user) = X  // SAME
```

All three "sessions" are the same session. Accumulation bound applies to total.

**Case B: User provides different hashPrevouts per session**

```text
Session 1: hashPrevouts = sha256d(input_0 only)  → sig_0 commits to this
Session 2: hashPrevouts = sha256d(input_1 only)  → sig_1 commits to this
Session 3: hashPrevouts = sha256d(input_2 only)  → sig_2 commits to this
```

Actual transaction needs:

```text
hashPrevouts = sha256d(input_0 || input_1 || input_2)
```

None of the signatures are valid. They each commit to different (fictional) transactions.

**Status:** ✅ IMPOSSIBLE (cryptographic structure prevents it)

---

### 8.5 Core Invariant Proof

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
2. `authorized_input_total` cannot exceed `expected_input_total` (enforced by accumulation bound)
3. `user_cost` is reserved from user's balance (enforced by balance reservation)

All three dependencies are enforced by the design. The proof holds.

---

### 8.6 Additional Attack Analysis

#### Attack 5: Misrepresent Input Amounts

**Goal:** Claim UTXOs are worth less than actual value to reduce reserved balance.

**Why this fails:** BIP143 sighash preimage includes the `amount` field. If user claims UTXO is 3 BTC but actual value is 10 BTC, MPC builds preimage with 3 BTC, producing a signature invalid on Bitcoin. The user wastes transaction costs but cannot steal from the vault.

**Status:** ✅ SELF-DEFEATING

#### Attack 6: Double-Sign Outpoint Across Sessions

**Goal:** Create multiple sessions using same UTXO, extract value multiple times.

**Why this is safe:** Bitcoin consensus ensures only one transaction spending the UTXO can confirm. The winning session succeeds; losing sessions are refunded. User over-reserves capital (inefficient for them), but vault invariant holds.

**Status:** ✅ SAFE BY DESIGN

#### Attack 7: MPC as Arbitrary Signing Oracle

**Goal:** Get MPC to sign arbitrary digest for unauthorized transaction.

**Mitigation:** MPC never signs raw digests. It only accepts structured `SignWithdrawInputPayload` and constructs the BIP143 preimage internally. No code path exists to sign an arbitrary 32-byte value.

**Status:** ✅ MITIGATED

#### Attack 8: Manipulate Outputs After Session Creation

**Goal:** Create session with valid outputs, then change outputs before signing.

**Why this fails:** `hashOutputs` is pinned at session creation and stored in session PDA. Every signature commits to `hashOutputs` via BIP143 preimage. User cannot modify stored `hashOutputs`. Different outputs produce different hashes, making existing signatures invalid.

**Status:** ✅ CRYPTOGRAPHIC BINDING

---

## 9. Deposit Protocol

### 9.1 Overview

Enable users to transfer Bitcoin from their **unique derived address** (MPC-controlled, per-user) to the **main vault address**, crediting their Solana balance upon confirmation.

```text
External World → User's Derived Address → Vault Address → Solana Balance Credit
                 (MPC controlled)         (MPC controlled)
```

The same parallel UTXO signing architecture applies—users may have multiple UTXOs at their derived address that need consolidation into a single deposit transaction.

### 9.2 Fundamental Asymmetry: Deposit vs Withdrawal

| Aspect | Withdrawal | Deposit |
| ------ | ---------- | ------- |
| Source of funds | Vault (shared pool) | User's derived address (per-user) |
| Funds already credited on Solana? | **YES** | **NO** |
| Who loses if change is misdirected? | Vault (theft) | User only (their choice) |
| Who loses if fee is inflated? | Vault (drained to miners) | User only (less credit) |
| Balance reservation required? | **YES** (critical) | **NO** |
| Change validation required? | **YES** (critical) | **NO** |
| Accumulation bound required? | **YES** (critical) | **NO** |
| Input ownership validation required? | **NO** (vault inputs) | **YES** (critical) |

**Key insight:** At the user's derived address, the BTC exists but is **not yet credited** to their Solana balance. Credit occurs only when funds arrive at the vault. Until then, the user is spending their own uncredited funds.

### 9.3 Deposit Threat Model

**Primary invariant:** A user must not be able to credit their Solana balance with more than they actually deposited to the vault.

```text
solana_balance_credited ≤ btc_actually_received_by_vault
```

**Secondary invariant:** A user must not be able to spend funds from another user's derived address.

```text
inputs_spent ⊆ user's_own_derived_utxos
```

**Not security concerns (user responsibility):**

- User sends less than intended (partial deposit)
- User overpays fees (less credit)
- User sends change to external address (their choice)
- Transaction does not confirm (no credit given)

### 9.4 Deposit Security Model

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
  Vault validates: scriptCode.derives_from(user_derived_script)

At Bitcoin broadcast (if Vault validation bypassed):
  BIP143 sighash commits to scriptCode in preimage
  Actual UTXO has different scriptPubKey → sighash mismatch → invalid signature

Therefore: only user's own UTXOs produce valid signatures  ∎
```

**Two mechanisms enforce security:**

| Mechanism | What it prevents | Why it is required |
| --------- | ---------------- | ------------------ |
| **Input ownership validation** | User stealing from other users' derived addresses | Without this, user A could spend user B's UTXOs |
| **Credit from actual output** | User claiming more than deposited | Without this, user could claim arbitrary credit |

### 9.5 Deposit Session Flow

This section defines new Vault Program instructions for parallel deposit signing. These extend the existing `deposit_btc` / `claim_btc` pattern.

**Proposed Instructions:**

| Instruction | Purpose | Caller |
| ----------- | ------- | ------ |
| `create_deposit_session` | Create session PDA, verify vault output exists | User |
| `sign_deposit_input` | Sign one deposit input, validate ownership | User |
| `confirm_deposit_success` | Credit balance after BTC confirmation | MPC |

**1) Create Deposit Session:**

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

**Vault validation:**

```text
// 1. Verify at least one output goes to vault
vault_output = outputs.find(o => o.script == VAULT_SCRIPT_PUBKEY)
require!(vault_output.is_some(), "No vault output in deposit")

// 2. Compute hashOutputs and derive session ID
hashOutputs = sha256d(serialize(outputs))
session_id = sha256(hashPrevouts || hashSequence || hashOutputs || user_pubkey)

// 3. Create session (NO balance reservation needed)
```

**2) Sign Deposit Input:**

```text
sign_deposit_input(session_id, outpoint, amount_sats, sequence, scriptCode)
```

**Vault validation:**

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

**3) Deposit Confirmation:**

```text
confirm_deposit_success(session_id, spending_txid, actual_outputs, signature)
```

**Vault handling:**

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

### 9.6 Deposit Attack Analysis

**Attack 1: Steal From Other Users' Derived Addresses**

Vault validates that scriptCode matches user's derivation path. BIP143 provides second-layer defense: if attacker provides wrong scriptCode, resulting signature is invalid on Bitcoin.

**Status:** ✅ MITIGATED (two-layer defense)

**Attack 2: Claim More Credit Than Deposited**

Credit is based on actual Bitcoin outputs observed by MPC, not user claims.

**Status:** ✅ MITIGATED

**Attack 3-4: Double-Credit Attempts**

Session ID derivation ensures identical parameters produce identical session IDs. Bitcoin consensus ensures only one transaction per UTXO confirms.

**Status:** ✅ MITIGATED

**Attack 5: Replay Confirmation Callback**

Session state machine prevents duplicate callbacks. UTXO tracking provides defense in depth.

**Status:** ✅ MITIGATED

**Attack 6: Front-Running / MEV**

Only the user (via MPC with their derivation path) can produce valid signatures for their derived address.

**Status:** ✅ NOT POSSIBLE

### 9.7 Deposit Summary

The deposit flow is significantly simpler than withdrawal because the user is converting uncredited external value into credited internal balance.

| Mechanism | Withdrawal | Deposit | Reason |
| --------- | ---------- | ------- | ------ |
| Balance reservation | ✅ Required | ❌ Not needed | No pre-existing balance to protect |
| Accumulation bound | ✅ Required | ❌ Not needed | Over-fee only affects user |
| Change validation | ✅ Required | ❌ Not needed | User's uncredited funds |

The only critical validation is input ownership—ensuring users can only spend from their own derived addresses.

---

## 10. Conclusion

The Parallel UTXO Signing Architecture is secure against its stated threat model.

The core invariant `vault_value_spent ≤ user_balance_reserved` is mathematically guaranteed by three interlocking mechanisms:

1. **Balance reservation** — locks funds at session creation
2. **Input accumulation bound** — caps total signable value
3. **Change address validation** — ensures vault receives its change

Each mechanism is necessary; removing any single mechanism breaks the invariant. Together, they provide complete defense against user theft and vault drain.

**Key design properties:**

- **No time-based expiration:** Sessions resolve based on Bitcoin state (success or impossible).
- **Outpoint reuse allowed:** Multiple sessions can reference the same UTXO; Bitcoin consensus ensures only one succeeds, others are refunded.
- **Session splitting impossible:** BIP143 cryptographic structure forces all inputs of one transaction into one session via the `session_id` derivation.

**Trust assumption:** MPC is honest (or Byzantine-fault-tolerant with threshold cryptography). If MPC is fully compromised, it could sign arbitrary transactions regardless of Vault constraints.
