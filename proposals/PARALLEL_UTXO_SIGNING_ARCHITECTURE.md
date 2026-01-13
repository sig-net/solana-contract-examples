# Parallel UTXO Signing Architecture

## 1. Overview

### 1.1 Problem Statement

Solana transactions are limited to approximately 1,232 bytes. Bitcoin transaction data scales linearly with the number of inputs, causing full Bitcoin transaction or PSBT data transmitted through Solana to quickly exceed this limit (typically at 3-5 inputs).

**Objective:** Enable unlimited UTXO inputs for vault consolidation and large withdrawals by signing inputs in parallel across multiple Solana transactions.

### 1.2 Proposed Solution

Leverage BIP143's SegWit v0 sighash structure to sign each input independently in separate Solana transactions, while ensuring all signatures commit to the same Bitcoin inputs and outputs.

**Key insight:** In BIP143 with `SIGHASH_ALL`, the sighash preimage contains transaction-wide fields that remain constant for all inputs:

- `nVersion` — transaction version
- `hashPrevouts` — commits to all input outpoints
- `hashSequence` — commits to all input sequences
- `hashOutputs` — commits to all outputs
- `nLockTime` — transaction lock time
- `sighashType` — signature hash type

These fields are combined into a single `txCommit = sha256(DOMAIN || nVersion || nLockTime || sighashType || hashPrevouts || hashSequence || hashOutputs)` that uniquely identifies the transaction shape. Instead of transmitting a full PSBT, the system passes only these commitments plus per-input fields.

### 1.3 Scope and Assumptions

- **Bitcoin inputs:** SegWit v0 spends using BIP143 and ECDSA signatures with `SIGHASH_ALL` (P2WPKH, P2WSH, or nested SegWit).
- **Outputs:** Fixed structure of two outputs: user withdrawal and vault change.
- **MPC signing request:** MPC receives serialized per-input signing data (not a precomputed digest) and constructs the BIP143 preimage deterministically.

### 1.4 System Components

This proposal extends the existing Signet architecture:

| Component                   | Repository                 | Role                                                                      |
| --------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| **ChainSignatures Program** | `signet-solana-program`    | Core MPC signing infrastructure (`sign`, `sign_bidirectional`, `respond`) |
| **Vault Program**           | `solana-contract-examples` | BTC/ERC20 vault logic (`deposit_btc`, `withdraw_btc`, etc.)               |
| **MPC Network**             | `mpc`                      | Threshold ECDSA signing (5-of-8), Bitcoin observation                     |

The Vault Program issues CPI calls to ChainSignatures for signature requests.

---

## 2. Architecture

### 2.1 Trust Architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│  VAULT PROGRAM (solana-contract-examples)                        │
│  • Session management, balance tracking, security enforcement    │
│  • Resolves session outcomes using MPC attestations (Section 7)  │
└───────────────────────────────┬──────────────────────────────────┘
                                │ CPI
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│  CHAIN SIGNATURES PROGRAM (signet-solana-program)                │
│  • Signing requests (sign_bidirectional) and responses (respond) │
│  • Bitcoin attestations (respond_bidirectional)                  │
└───────────────────────────────┬──────────────────────────────────┘
                                │ Events
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│  MPC NETWORK (mpc)                                               │
│  • Signs BIP143 payloads for Bitcoin inputs                      │
│  • Tracks session commitments (hashPrevouts → outpoints)         │
│  • Observes Bitcoin, attests to session outcomes (Section 7)     │
└──────────────────────────────────────────────────────────────────┘
```

See **Section 7** for detailed attestation structure and resolution flow.

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
- The `session_id` is derived from all tx-wide sighash fields via `txCommit` (see Section 5.1)
- Identical commitments produce identical session IDs (accumulation bound applies)
- Different commitments produce incompatible signatures (invalid on Bitcoin)

**See [Section 8.4: Attack 4 - Session Splitting](#84-attack-4-session-splitting) for the formal proof.**

---

## 4. Security Framework

### 4.1 Three Enforcement Mechanisms

| Mechanism                        | What it prevents                                        | Why it is required                                               |
| -------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| **Optimistic balance decrement** | User creating sessions exceeding their balance          | Without this, user could sign without funds to back it           |
| **Input accumulation bound**     | User signing more inputs than `sum(outputs) + fee`      | Without this, excess inputs become unaccounted fee (vault drain) |
| **Change address validation**    | User claiming change while only paying `user_out + fee` | Without this, the invariant fails                                |

**Removing any single mechanism breaks the invariant.**

### 4.2 Control and Enforcement Summary

| User Controls        | Vault Enforces                          | Result                           |
| -------------------- | --------------------------------------- | -------------------------------- |
| Withdrawal amount    | Change output → vault address           | User cannot steal change         |
| Fee amount           | `sum(inputs) ≤ outputs + declared_fee`  | User cannot inflate fees         |
| Which inputs to sign | Balance decremented at session creation | User cannot outrun their balance |
| Session ID           | Derived from commitments                | User cannot hijack sessions      |
| Input amounts        | BIP143 commits to amount                | User cannot lie (self-defeating) |

---

## 5. Withdrawal Protocol: Security Invariants

### 5.1 Session Key Derivation

Session keys are derived deterministically from **all tx-wide BIP143 sighash fields** via a `txCommit` intermediate hash:

```text
DOMAIN = "signet:btc:v1"

txCommit = sha256(
  DOMAIN       ||    // Domain separation (prevents cross-protocol collisions)
  nVersion     ||    // 4 bytes LE
  nLockTime    ||    // 4 bytes LE
  sighashType  ||    // 4 bytes LE (SIGHASH_ALL = 0x01)
  hashPrevouts ||    // 32 bytes
  hashSequence ||    // 32 bytes
  hashOutputs       // 32 bytes
)

Vault (Solana contract):
  session_id = sha256(txCommit || user_pubkey)

MPC (internal tracking):
  mpc_session_key = txCommit
```

**Why Vault and MPC differ:**

- **Vault includes `user_pubkey`:** Ensures per-user session isolation on Solana. Two users with identical transaction parameters get different session PDAs.
- **MPC uses `txCommit` directly:** MPC tracks sessions by transaction shape only. The same Bitcoin transaction maps to one MPC session regardless of which Solana user initiated it.

**Rationale:**

- **Prevents session confusion attacks:** A user-provided session ID could collide with or reference another user's session.
- **Ensures deterministic verification:** Given the same tx params and user, the session ID is always identical.
- **Prevents replay across sessions:** Each unique transaction shape produces a unique session ID.
- **Idempotent session creation:** Calling `create_withdraw_btc_session` twice with identical parameters returns the same session ID.
- **Enforces transaction integrity:** This derivation makes session splitting attacks impossible.
- **Auditability:** All sighash-relevant fields are explicit in the commitment, making debugging straightforward.

**Implementation note:** The session PDA seed should include this derived `session_id`, making it impossible to create conflicting sessions.

---

### 5.2 Explicit Fee Declaration with Optimistic Balance Decrement

The session **must** include an explicit `declared_fee` amount. Balance is **optimistically decremented** (not merely checked) at session creation, and input accumulation is strictly bounded.

**Session creation parameters:**

```text
create_withdraw_btc_session {
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

**Optimistic balance decrement (critical):**

At session creation, the Vault **immediately decrements** `user_cost` from the user's balance. This follows the existing `withdraw_btc` pattern:

```text
require!(balance.amount >= user_cost, "Insufficient balance")
balance.amount -= user_cost  // optimistic decrement
```

The session PDA stores `user_cost` for potential refund on failure.

This prevents race conditions where a user:

1. Creates session with balance = 10 BTC
2. Transfers 10 BTC to another account
3. Completes signing with 0 BTC backing

With optimistic decrement, step 2 fails because the balance is already reduced.

**Input accumulation bound (critical):**

During each `sign_withdraw_btc_input`, the Vault enforces:

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
   - Session B is refunded (balance.amount += session.user_cost)

3. **User bears optionality cost:** Creating multiple sessions for the same UTXOs locks additional capital. This represents the user's choice.

4. **No vault risk:** The invariant `vault_loss ≤ user_cost` holds per-session. Multiple sessions mean multiple decrements; only one can succeed.

**Use case:** Users may want transaction flexibility (different fee levels, different output amounts) and prepare multiple options. They pay for this optionality through locked capital.

---

### 5.5 Session Lifecycle

Sessions do **not** expire based on time. A session resolves only when its fate is determined on Bitcoin.

| State         | Condition                                                 | Balance       |
| ------------- | --------------------------------------------------------- | ------------- |
| **ACTIVE**    | Session created, awaiting Bitcoin confirmation            | Decremented   |
| **COMPLETED** | Session's exact transaction confirmed (both hashes match) | Remains spent |
| **FAILED**    | Any session input spent in a different transaction        | Refunded      |

See **Section 7** for MPC attestation structure and Vault resolution logic.

---

### 5.6 MPC Signing Constraints

The Vault must only request MPC signatures using **structured** BIP143 signing payloads (fields that deterministically map to the BIP143 preimage). The system must not allow any path where a user supplies an arbitrary 32-byte digest to be signed.

**Rationale:**

If MPC signed arbitrary 32-byte digests, a malicious user could:

1. Compute their own sighash for a different transaction
2. Submit it as a payload through some other code path
3. Obtain an MPC signature for an unauthorized transaction

By requiring structured input (outpoint, amount, scriptCode, commitments), the MPC constructs the preimage internally. Signatures are only valid for the declared transaction shape.

Additionally, structured payloads are operationally necessary for MPC to fulfill its observation role (Section 7). The `outpoint` field enables MPC to watch the correct UTXO on Bitcoin, and `hashOutputs` enables verification of successful completion. With only a 32-byte digest, MPC would have no information about which UTXOs to track or how to confirm session outcomes.

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

| Instruction                     | Purpose                                                        | Caller   |
| ------------------------------- | -------------------------------------------------------------- | -------- |
| `create_withdraw_btc_session`   | Pin tx-wide fields, reserve balance, create session PDA        | User     |
| `sign_withdraw_btc_input`       | Sign one BTC input, update accumulator, CPI to ChainSignatures | User     |
| `cancel_withdraw_btc_session`   | Refund balance if no signatures issued                         | User     |
| `complete_withdraw_btc_session` | Finalize or refund balance after BTC outcome                   | Client\* |

\*Client relays MPC attestation from `RespondBidirectionalEvent`. Vault verifies the MPC signature and checks `serialized_output` to determine success (finalize) or failure (refund). This follows the existing `complete_withdraw_btc` pattern.

### 6.2 Create Session

User calls `create_withdraw_btc_session` with transaction parameters:

```text
create_withdraw_btc_session {
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

  // Transaction constants (all included in txCommit)
  nVersion:    u32,
  nLockTime:   u32,
  sighashType: u32   // SIGHASH_ALL = 0x01
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

// 3. Compute txCommit and derive session ID (NEVER user-provided)
txCommit = sha256(
  "signet:btc:v1" ||
  nVersion        ||
  nLockTime       ||
  sighashType     ||
  hashPrevouts    ||
  hashSequence    ||
  hashOutputs
)
session_id = sha256(txCommit || user_pubkey)

// 4. Optimistically decrement balance (prevents race conditions)
require!(balance.amount >= user_cost, "Insufficient balance")
balance.amount -= user_cost  // follows withdraw_btc pattern

// 5. Create WithdrawBtcSession PDA with derived session_id as seed
WithdrawBtcSession {
  session_id,
  txCommit,                     // stored for attestation verification
  user: user_pubkey,
  hashPrevouts,
  hashSequence,
  hashOutputs,
  nVersion,
  nLockTime,
  sighashType,
  declared_fee,
  expected_input_total,
  user_cost,                    // stored for potential refund
  authorized_input_total: 0,
  status: Active
}
```

### 6.3 Sign Input

For each Bitcoin input, user calls `sign_withdraw_btc_input`:

```text
sign_withdraw_btc_input(session_id, outpoint, amount_sats, sequence, scriptCode)
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
SignWithdrawBtcInputPayload {
  txCommit:      [u8; 32]   // session's txCommit (MPC uses as session key)

  // tx-wide commitments (from session, for BIP143 preimage construction)
  hashPrevouts:  [u8; 32]
  hashSequence:  [u8; 32]
  hashOutputs:   [u8; 32]
  nVersion:      u32
  nLockTime:     u32
  sighashType:   u32        // from session (SIGHASH_ALL = 0x01)

  // per-input fields (from call)
  outpoint_txid: [u8; 32]
  outpoint_vout: u32
  amount_sats:   u64
  sequence:      u32
  scriptCode:    bytes
}
```

MPC deterministically constructs the BIP143 preimage from this payload, computes `sha256d(preimage)`, and produces the ECDSA signature. MPC uses `txCommit` as its session key for tracking.

---

## 7. MPC Attestation and Vault Resolution

MPC tracks session commitments during signing and observes Bitcoin to determine session outcomes. When any outpoint from a tracked session is spent, MPC attests to whether the session succeeded or failed.

### 7.1 MPC Session Tracking

During each `sign_withdraw_btc_input` call, MPC receives the signing payload containing `txCommit` and per-input fields. MPC uses `txCommit` directly as its session key (includes all tx-wide sighash fields):

```text
MPC session key (from payload):
  mpc_session_key = payload.txCommit   // Already computed by Vault

MPC Internal State:
  watched_sessions: Map<txCommit, WatchedSession>

WatchedSession {
  txCommit:      [u8; 32]           // Full transaction commitment
  nVersion:      u32                // For verification/debugging
  nLockTime:     u32                // For verification/debugging
  sighashType:   u32                // For verification/debugging
  hashPrevouts:  [u8; 32]           // For Bitcoin observation matching
  hashSequence:  [u8; 32]           // For Bitcoin observation matching
  hashOutputs:   [u8; 32]           // For Bitcoin observation matching
  outpoints:     Set<(txid, vout)>  // All outpoints signed for this session
}
```

**Recording flow:**

```text
on_sign_request(payload: SignWithdrawBtcInputPayload):
  session = watched_sessions.get_or_create(payload.txCommit)
  session.txCommit = payload.txCommit
  session.nVersion = payload.nVersion
  session.nLockTime = payload.nLockTime
  session.sighashType = payload.sighashType
  session.hashPrevouts = payload.hashPrevouts
  session.hashSequence = payload.hashSequence
  session.hashOutputs = payload.hashOutputs
  session.outpoints.add((payload.outpoint_txid, payload.outpoint_vout))
```

### 7.2 Attestation Structure

MPC emits a binary outcome attestation for each session, keyed by `txCommit`:

```text
SessionOutcomeAttestation {
  txCommit:              [u8; 32]   // Full session commitment (includes all tx-wide fields)
  success:               bool       // true = confirmed, false = failed
  spending_txid:         [u8; 32]   // Bitcoin tx that spent the input(s)
  block_height:          u64        // Confirmation height
  actual_outputs:        Vec<TxOut> // MPC-observed outputs from Bitcoin
  signature:             Signature  // MPC signature over all fields
}
```

MPC creates attestations after 6+ confirmations. The `actual_outputs` field contains the outputs MPC observed on Bitcoin, used by deposits to calculate credit amount.

**Why `txCommit` instead of separate hashes:** The attestation uses the same commitment structure as session creation, ensuring unambiguous matching. Vault verifies `attestation.txCommit == session.txCommit`.

### 7.3 MPC Observation Logic

```text
on_bitcoin_block(block):
  for tx in block.transactions:
    // Compute BIP143 commitments from observed transaction
    tx_hashPrevouts = compute_bip143_hashPrevouts(tx)
    tx_hashSequence = compute_bip143_hashSequence(tx)
    tx_hashOutputs = compute_bip143_hashOutputs(tx)

    for input in tx.inputs:
      outpoint = (input.prev_txid, input.prev_vout)

      // Check if this outpoint belongs to any watched session
      for (txCommit, session) in watched_sessions:
        if outpoint in session.outpoints:

          // Compute txCommit for observed transaction (using session's constants)
          tx_txCommit = sha256(
            "signet:btc:v1"       ||
            session.nVersion     ||   // Use session's expected values
            session.nLockTime    ||
            session.sighashType  ||
            tx_hashPrevouts      ||   // From observed tx
            tx_hashSequence      ||   // From observed tx
            tx_hashOutputs            // From observed tx
          )

          // Determine outcome: does spending tx match session?
          success = (tx_txCommit == session.txCommit)

          emit SessionOutcomeAttestation {
            txCommit:       session.txCommit,
            success:        success,
            spending_txid:  tx.txid(),
            block_height:   block.height,
            actual_outputs: tx.outputs,
          }

          // Session resolved, stop watching
          watched_sessions.remove(txCommit)
```

**Key property:** MPC emits an attestation whenever ANY outpoint from a session is spent, regardless of whether the spending transaction matches the session. This ensures sessions always resolve (success or failure) rather than getting stuck.

**Success determination:** The observed transaction's `txCommit` must exactly match the session's `txCommit`. This validates all tx-wide fields (nVersion, nLockTime, sighashType, hashPrevouts, hashSequence, hashOutputs) in a single comparison.

### 7.4 Resolution Logic

```text
complete_withdraw_btc_session(session_id, attestation)

1. Verify MPC signature over attestation

2. Load session PDA

3. Verify attestation matches session (single comparison):
   require!(attestation.txCommit == session.txCommit)

4. Apply outcome:
   if attestation.success:
     session.status = COMPLETED
     // Balance remains spent
   else:
     session.status = FAILED
     balance.amount += session.user_cost  // Refund
```

| Outcome | Condition                      | Action                |
| ------- | ------------------------------ | --------------------- |
| SUCCESS | `attestation.success == true`  | Balance remains spent |
| FAILURE | `attestation.success == false` | Refund user           |

### 7.5 Flow Diagram

```text
User/Client              Vault Program          ChainSignatures         MPC                 Bitcoin
  │                          │                        │                  │                     │
  │ create_withdraw_btc_session()                     │                  │                     │
  ├─────────────────────────►│                        │                  │                     │
  │                          │ 1. validate change     │                  │                     │
  │                          │ 2. compute hashOutputs │                  │                     │
  │                          │ 3. compute txCommit    │                  │                     │
  │                          │ 4. derive session_id   │                  │                     │
  │                          │ 5. decrement balance   │                  │                     │
  │                          │ 6. store session PDA   │                  │                     │
  │◄──────── session_id ─────┤                        │                  │                     │
  │                          │                        │                  │                     │
  │ sign_withdraw_btc_input()│                        │                  │                     │
  ├─────────────────────────►│                        │                  │                     │
  │                          │ check accumulation     │                  │                     │
  │                          │ CPI ──────────────────►│                  │                     │
  │                          │                        │ emit SignBidirectionalEvent            │
  │                          │                        │ ────────────────►│                     │
  │                          │                        │                  │ 1. record outpoint  │
  │                          │                        │                  │    keyed by txCommit│
  │                          │                        │                  │ 2. sign(payload)    │
  │                          │                        │◄── respond() ────┤                     │
  │                          │                        │ emit SignatureRespondedEvent           │
  │◄──────── signature ──────┤◄───────────────────────┤                  │                     │
  │                          │                        │                  │                     │
  │ [repeat for each input]  │                        │                  │                     │
  │                          │                        │                  │                     │
  │ assemble + broadcast ─────────────────────────────────────────────────────────────────────►│
  │                          │                        │                  │                     │
  │                          │                        │                  │   observe (6 conf)  │
  │                          │                        │                  │   for each input:   │
  │                          │                        │                  │     find session    │
  │                          │                        │                  │     compute txCommit│
  │                          │                        │                  │     success = match?│
  │                          │                        │                  │   sign attestation  │
  │                          │                        │◄─ respond_bidirectional(attestation) ──┤
  │                          │                        │ emit RespondBidirectionalEvent         │
  │◄─ observe event ─────────┼────────────────────────┤                  │                     │
  │                          │                        │                  │                     │
  │ complete_withdraw_btc_session(session_id, attestation)               │                     │
  ├─────────────────────────►│                        │                  │                     │
  │                          │ 1. verify MPC sig      │                  │                     │
  │                          │ 2. verify txCommit     │                  │                     │
  │                          │    matches session     │                  │                     │
  │                          │ 3. if success: done    │                  │                     │
  │                          │    else: refund        │                  │                     │
  │                          │ 4. close session PDA   │                  │                     │
```

## 8. Security Analysis

### 8.1 Attack 1: Steal Change Output

**Goal:** User directs vault change to their own address, extracting more value than paid.

**Scenario:**

```text
User's balance: 10 BTC

User creates session:
  Output 0: 5 BTC → user's withdrawal address
  Output 1: 4 BTC → user's SECOND address (fake "vault change")
  declared_fee: 1 BTC

  user_cost = 5 + 1 = 6 BTC (decremented from balance)

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
  user_cost = 5 + 1 = 6 BTC (decremented from balance)

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
2. User creates session spending 6 BTC (balance CHECK passes: 10 >= 6)
3. User transfers 10 BTC to another account
4. User completes signing
5. Transaction confirms
6. Vault lost 10 BTC, user's balance was 0

Result: Vault drained without backing funds
```

**Mitigation:**

Balance is **optimistically decremented** (not just checked) at session creation:

```text
require!(balance.amount >= user_cost)
balance.amount -= user_cost
```

Step 3 fails because `balance.amount` is now 4 BTC (10 - 6 decremented).

**Status:** ✅ MITIGATED

---

### 8.4 Attack 4: Session Splitting

**Goal:** Withdraw more than the user's balance by splitting inputs across multiple sessions.

**Attack scenario:**

```text
User's balance: 20 BTC
Attacker wants to withdraw 25 BTC using 3 vault UTXOs (10 BTC each = 30 BTC total).

Honest approach:
  Single session: user_cost = 25 (withdrawal) + 1 (fee) = 26 BTC
  Balance check: 20 < 26 → REJECTED (insufficient balance)

Attack attempt:
  Create 3 separate sessions, each appearing to use only 1 input:
    Session A: hashPrevouts=H(input_0), user_cost = 6 BTC → balance: 20 - 6 = 14 ✓
    Session B: hashPrevouts=H(input_1), user_cost = 6 BTC → balance: 14 - 6 = 8  ✓
    Session C: hashPrevouts=H(input_2), user_cost = 6 BTC → balance: 8 - 6 = 2   ✓
  Total decremented: 18 BTC (within 20 BTC balance)

  Then combine all 3 signatures into one Bitcoin tx spending 30 BTC → 25 BTC withdrawal?
```

**Why this is cryptographically impossible:**

BIP143 signatures commit to `hashPrevouts`, which is a hash of ALL inputs:

```text
hashPrevouts = sha256d(outpoint_0 || outpoint_1 || outpoint_2)
```

For three signatures to be valid in the same Bitcoin transaction, they must ALL commit to the same `hashPrevouts` value.

**The dilemma:**

1. **If attacker uses correct hashPrevouts (all 3 inputs) for each session:**

   ```text
   txCommit_all = sha256(DOMAIN || nVersion || nLockTime || sighashType ||
                         H_all_prevouts || hashSeq || hashOut)

   Session A: session_id = sha256(txCommit_all || user)
   Session B: session_id = sha256(txCommit_all || user)  // IDENTICAL
   Session C: session_id = sha256(txCommit_all || user)  // IDENTICAL
   ```

   All three calls create/update the SAME session PDA. The accumulation bound applies to the total: after signing 30 BTC of inputs, bound is reached.

2. **If attacker uses different hashPrevouts per session:**

   ```text
   Session A: hashPrevouts = sha256d(outpoint_0)        → txCommit_A → sig_0 commits to this
   Session B: hashPrevouts = sha256d(outpoint_1)        → txCommit_B → sig_1 commits to this
   Session C: hashPrevouts = sha256d(outpoint_2)        → txCommit_C → sig_2 commits to this
   ```

   Each signature commits to a different `hashPrevouts` (and therefore different `txCommit`). The actual transaction requires:

   ```text
   hashPrevouts = sha256d(outpoint_0 || outpoint_1 || outpoint_2)
   ```

   None of the signatures are valid for this transaction. Bitcoin rejects the tx.

**Conclusion:** The attacker cannot have it both ways. Either all signatures use the same `txCommit` (forcing same session, accumulation bound applies), or signatures use different `txCommit` values (invalid on Bitcoin).

**Status:** ✅ IMPOSSIBLE

---

### 8.5 Open Problem: Poison Outpoint Refund Oracle

#### Problem

The current design allows the MPC to "watch" (and later attest about) **any outpoint that was signed** during a session. However, the protocol does not currently prove that every signed/watched outpoint is actually part of the committed input set represented by `hashPrevouts` (and `hashSequence`).

This enables a **refund oracle**: the user can obtain a valid withdrawal on Bitcoin *and* a refund on Solana by injecting a signed outpoint that is **not included** in the committed `hashPrevouts`.

#### Attack: Poison Outpoint → Forced Failure Attestation While Withdrawal Still Succeeds

**Goal:** Force `success=false` attestation (refund) without preventing the "real" withdrawal transaction from confirming.

**Scenario:**

1. User creates a withdrawal session with a legitimate commitment:
   - `hashPrevouts/hashSequence` correspond to the **real input list** `L` that will be used in the final Bitcoin transaction.
2. User obtains signatures for every input in `L` (so the final withdrawal transaction is fully signable).
3. User additionally requests a signature for a **poison outpoint** `P` that is *not* included in `L` (and therefore not included in `hashPrevouts/hashSequence`).
4. User causes `P` to be spent in an unrelated Bitcoin transaction.
5. MPC observes `P` spent and emits a **failure attestation** (`success=false`) because the spending transaction's commitments do not match the session commitments.
6. User submits `complete_withdraw_btc_session(..., success=false attestation ...)` and receives a refund on Solana.
7. User broadcasts the real withdrawal transaction using `L`. It confirms on Bitcoin.

**Result:** User receives BTC on Bitcoin and is refunded on Solana → vault loss without user cost.

**Root cause:** The session's "watched outpoints" are not provably equal to the committed outpoints implied by `hashPrevouts/hashSequence`.

---

#### Proposed Solution: On-Chain Input Manifest + Commitment Verification Gate

To make **refunds safe**, the Vault must ensure that **every signed/watched outpoint is a member of the committed input list** (the list hashed into `hashPrevouts` and `hashSequence`).

This is achieved by storing an **input manifest** in the session PDA and requiring the manifest to match the commitments before allowing any failure-based refund.

##### Additive Requirements (Poison-Outpoint Mitigation Only)

**A) User declares number of inputs**

At session creation, the user provides:

```text
num_inputs: u32
```

This is the expected length `N` of the committed input list.

**B) Each signed input is stored in the session**

On each `sign_withdraw_btc_input`, the Vault stores the input identifier in the session manifest:

- `outpoint = (txid, vout)` (36 bytes)
- `sequence` (4 bytes)

To avoid relying on Solana transaction ordering, the signing call provides a stable index:

```text
input_index: u32   // 0 <= input_index < num_inputs
```

This allows inputs to be signed in any order while keeping a deterministic BIP143 input ordering for hashing.

**C) Refunds require manifest verification**

Failure resolution (refund) is only allowed after the Vault verifies that the stored manifest hashes to the committed `hashPrevouts` and `hashSequence`.

---

##### Session Fields (Stored in `WithdrawBtcSession` PDA)

```text
num_inputs:       u32
inputs_filled:    u32
inputs_verified:  bool

// Manifest (zero-copy friendly):
// outpoints[i] = txid[32] || vout[4]
// sequences[i] = u32
outpoints:  [u8; 36 * num_inputs]
sequences:  [u8; 4  * num_inputs]
```

##### Vault Logic (Pseudocode)

**On `sign_withdraw_btc_input(session_id, input_index, outpoint, sequence, ...)`:**

```text
require!(input_index < session.num_inputs, "Index out of range")

// Store (or enforce consistency if already stored)
if manifest_slot[input_index] is empty:
  manifest_slot[input_index] = (outpoint, sequence)
  session.inputs_filled += 1
else:
  require!(manifest_slot[input_index] == (outpoint, sequence), "Input mismatch")

// Once all inputs are present, verify commitments exactly once
if session.inputs_filled == session.num_inputs and !session.inputs_verified:
  computed_hashPrevouts = sha256d(outpoints[0] || outpoints[1] || ... || outpoints[N-1])
  computed_hashSequence = sha256d(sequences[0] || sequences[1] || ... || sequences[N-1])

  require!(computed_hashPrevouts == session.hashPrevouts, "hashPrevouts mismatch")
  require!(computed_hashSequence == session.hashSequence, "hashSequence mismatch")

  session.inputs_verified = true
```

**On `complete_withdraw_btc_session(session_id, attestation)`:**

```text
verify_mpc_signature(attestation)
require!(attestation.txCommit == session.txCommit)

// Poison-outpoint mitigation gate:
if attestation.success == false:
  require!(session.inputs_verified, "Inputs not verified; refund blocked")

// Apply existing success/failure handling unchanged
```

##### Why This Fix Works

With this gate in place:

1. The Vault will only accept a failure refund after it has proven that the session's committed input set (`hashPrevouts/hashSequence`) corresponds exactly to the stored manifest.
2. Therefore, any outpoint that MPC watches (because it was signed under this session) must be one of the committed outpoints.
3. A user can no longer introduce an "extra" signed outpoint to trigger a failure attestation while still broadcasting a successful withdrawal transaction.

**Effect:** The poison outpoint refund oracle becomes impossible.

**Status:** 🔶 PROPOSED FIX (requires implementation)

## 9. Deposit Protocol

### 9.1 Overview

Enable users to transfer Bitcoin from their **unique derived address** (MPC-controlled, per-user) to the **main vault address**, crediting their Solana balance upon confirmation.

```text
External World → User's Derived Address → Vault Address → Solana Balance Credit
                 (MPC controlled)         (MPC controlled)
```

The same parallel UTXO signing architecture applies—users may have multiple UTXOs at their derived address that need consolidation into a single deposit transaction.

### 9.2 Fundamental Asymmetry: Deposit vs Withdrawal

| Aspect                               | Withdrawal                | Deposit                           |
| ------------------------------------ | ------------------------- | --------------------------------- |
| Source of funds                      | Vault (shared pool)       | User's derived address (per-user) |
| Funds already credited on Solana?    | **YES**                   | **NO**                            |
| Who loses if change is misdirected?  | Vault (theft)             | User only (their choice)          |
| Who loses if fee is inflated?        | Vault (drained to miners) | User only (less credit)           |
| Optimistic balance decrement?        | **YES** (critical)        | **NO**                            |
| Change validation required?          | **YES** (critical)        | **NO**                            |
| Accumulation bound required?         | **YES** (critical)        | **NO**                            |
| Input ownership validation required? | **NO** (vault inputs)     | **YES** (critical)                |

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
At sign_deposit_btc_input:
  Vault validates: scriptCode.derives_from(user_derived_script)

At Bitcoin broadcast (if Vault validation bypassed):
  BIP143 sighash commits to scriptCode in preimage
  Actual UTXO has different scriptPubKey → sighash mismatch → invalid signature

Therefore: only user's own UTXOs produce valid signatures  ∎
```

**Two mechanisms enforce security:**

| Mechanism                      | What it prevents                                  | Why it is required                              |
| ------------------------------ | ------------------------------------------------- | ----------------------------------------------- |
| **Input ownership validation** | User stealing from other users' derived addresses | Without this, user A could spend user B's UTXOs |
| **Credit from actual output**  | User claiming more than deposited                 | Without this, user could claim arbitrary credit |

### 9.5 Deposit Session Flow

This section defines new Vault Program instructions for parallel deposit signing. These extend the existing `deposit_btc` / `claim_btc` pattern.

**Proposed Instructions:**

| Instruction                  | Purpose                                        | Caller   |
| ---------------------------- | ---------------------------------------------- | -------- |
| `create_deposit_btc_session` | Create session PDA, verify vault output exists | User     |
| `sign_deposit_btc_input`     | Sign one deposit input, validate ownership     | User     |
| `claim_deposit_btc_session`  | Credit balance after BTC confirmation          | Client\* |

\*Client relays MPC attestation from `RespondBidirectionalEvent`. Vault verifies the MPC signature before crediting balance. This follows the existing `claim_btc` pattern.

**1) Create Deposit Session:**

```text
create_deposit_btc_session {
  hashPrevouts: [u8; 32],
  hashSequence: [u8; 32],
  outputs: [
    { script: VAULT_SCRIPT_PUBKEY, amount: deposit_amount },
    { script: change_address,      amount: change_amount }  // Optional, any address
  ],
  nVersion:    u32,
  nLockTime:   u32,
  sighashType: u32   // SIGHASH_ALL = 0x01
}
```

**Vault validation:**

```text
// 1. Verify at least one output goes to vault
vault_output = outputs.find(o => o.script == VAULT_SCRIPT_PUBKEY)
require!(vault_output.is_some(), "No vault output in deposit")

// 2. Compute hashOutputs, txCommit, and derive session ID
hashOutputs = sha256d(serialize(outputs))
txCommit = sha256(
  "signet:btc:v1" ||
  nVersion        ||
  nLockTime       ||
  sighashType     ||
  hashPrevouts    ||
  hashSequence    ||
  hashOutputs
)
session_id = sha256(txCommit || user_pubkey)

// 3. Create session (NO balance decrement needed for deposits)
DepositBtcSession {
  session_id,
  txCommit,
  user: user_pubkey,
  hashPrevouts,
  hashSequence,
  hashOutputs,
  nVersion,
  nLockTime,
  sighashType,
  status: Active
}
```

**2) Sign Deposit Input:**

```text
sign_deposit_btc_input(session_id, outpoint, amount_sats, sequence, scriptCode)
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
SignDepositBtcInputPayload {
  txCommit:      session.txCommit,
  hashPrevouts:  session.hashPrevouts,
  hashSequence:  session.hashSequence,
  hashOutputs:   session.hashOutputs,
  nVersion:      session.nVersion,
  nLockTime:     session.nLockTime,
  sighashType:   session.sighashType,
  outpoint_txid: outpoint.txid,
  outpoint_vout: outpoint.vout,
  amount_sats:   amount_sats,
  sequence:      sequence,
  scriptCode:    scriptCode,
}
```

**3) Claim Deposit:**

Resolution follows the same attestation flow as withdrawals (see **Section 7**). The attestation includes `actual_outputs` observed by MPC from Bitcoin.

```text
claim_deposit_btc_session(session_id, attestation)
```

**Vault handling:**

```text
// 1. Verify MPC signature over attestation

// 2. Verify attestation matches session (single comparison)
require!(attestation.txCommit == session.txCommit)

// 3. Calculate deposit from MPC-attested outputs
vault_outputs = attestation.actual_outputs.filter(o => o.script == VAULT_SCRIPT_PUBKEY)
actual_deposit = sum(vault_outputs.map(o => o.amount))

// 4. Credit user based on MPC-attested receipt
user.solana_balance += actual_deposit

session.status = Completed
```
