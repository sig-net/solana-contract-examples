# Parallel UTXO Signing Architecture

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
- The `session_id` is derived from `hashPrevouts || hashSequence || hashOutputs || user_pubkey`
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

### 5.1 Session ID Derivation

The `session_id` **must** be deterministically derived from the transaction commitment hashes:

```text
session_id = sha256(hashPrevouts || hashSequence || hashOutputs || user_pubkey)
```

**Rationale:**

- **Prevents session confusion attacks:** A user-provided session ID could collide with or reference another user's session.
- **Ensures deterministic verification:** Given the same commitments and user, the session ID is always identical.
- **Prevents replay across sessions:** Each unique transaction shape produces a unique session ID.
- **Idempotent session creation:** If a user calls `create_withdraw_btc_session` twice with identical parameters, they receive the same session ID.
- **Enforces transaction integrity:** This derivation makes session splitting attacks impossible.

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

// 4. Optimistically decrement balance (prevents race conditions)
require!(balance.amount >= user_cost, "Insufficient balance")
balance.amount -= user_cost  // follows withdraw_btc pattern

// 5. Create WithdrawBtcSession PDA with derived session_id as seed
WithdrawBtcSession {
  session_id,
  user: user_pubkey,
  hashPrevouts,
  hashSequence,
  hashOutputs,
  nVersion,
  nLockTime,
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

---

## 7. MPC Attestation and Vault Resolution

MPC tracks session commitments during signing and observes Bitcoin to determine session outcomes. When any outpoint from a tracked session is spent, MPC attests to whether the session succeeded or failed.

### 7.1 MPC Session Tracking

During each `sign_withdraw_btc_input` call, MPC receives the signing payload containing `hashPrevouts`, `hashOutputs`, and the input's `outpoint`. MPC maintains an internal mapping:

```text
MPC Internal State:
  watched_sessions: Map<hashPrevouts, WatchedSession>

WatchedSession {
  hashPrevouts:  [u8; 32]           // Session's input commitment
  hashOutputs:   [u8; 32]           // Session's output commitment
  outpoints:     Set<(txid, vout)>  // All outpoints signed for this session
}
```

**Recording flow:**

```text
on_sign_request(payload: SignWithdrawBtcInputPayload):
  session = watched_sessions.get_or_create(payload.hashPrevouts)
  session.hashOutputs = payload.hashOutputs
  session.outpoints.add((payload.outpoint_txid, payload.outpoint_vout))
```

### 7.2 Attestation Structure

MPC emits a binary outcome attestation for each session:

```text
SessionOutcomeAttestation {
  session_hashPrevouts:  [u8; 32]   // Identifies the session
  session_hashOutputs:   [u8; 32]   // Expected outputs
  success:               bool       // true = confirmed, false = failed
  spending_txid:         [u8; 32]   // Bitcoin tx that spent the input(s)
  block_height:          u64        // Confirmation height
  signature:             Signature  // MPC signature over all fields
}
```

MPC creates attestations after 6+ confirmation

### 7.3 MPC Observation Logic

```text
on_bitcoin_block(block):
  for tx in block.transactions:
    tx_hashPrevouts = compute_bip143_hashPrevouts(tx)
    tx_hashOutputs = compute_bip143_hashOutputs(tx)

    for input in tx.inputs:
      outpoint = (input.prev_txid, input.prev_vout)

      // Check if this outpoint belongs to any watched session
      for session in watched_sessions.values():
        if outpoint in session.outpoints:

          // Determine outcome: does spending tx match session?
          success = (tx_hashPrevouts == session.hashPrevouts) AND
                    (tx_hashOutputs == session.hashOutputs)

          emit SessionOutcomeAttestation {
            session_hashPrevouts: session.hashPrevouts,
            session_hashOutputs:  session.hashOutputs,
            success:              success,
            spending_txid:        tx.txid(),
            block_height:         block.height,
          }

          // Session resolved, stop watching
          watched_sessions.remove(session.hashPrevouts)
          break
```

**Key property:** MPC emits an attestation whenever ANY outpoint from a session is spent, regardless of whether the spending transaction matches the session. This ensures sessions always resolve (success or failure) rather than getting stuck.

### 7.4 Resolution Logic

```text
complete_withdraw_btc_session(session_id, attestation)

1. Verify MPC signature over attestation

2. Load session PDA

3. Verify attestation matches session:
   require!(attestation.session_hashPrevouts == session.hashPrevouts)
   require!(attestation.session_hashOutputs == session.hashOutputs)

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
  │                          │ 3. derive session_id   │                  │                     │
  │                          │ 4. decrement balance   │                  │                     │
  │                          │ 5. store session PDA   │                  │                     │
  │◄──────── session_id ─────┤                        │                  │                     │
  │                          │                        │                  │                     │
  │ sign_withdraw_btc_input()│                        │                  │                     │
  ├─────────────────────────►│                        │                  │                     │
  │                          │ check accumulation     │                  │                     │
  │                          │ CPI ──────────────────►│                  │                     │
  │                          │                        │ emit SignBidirectionalEvent            │
  │                          │                        │ ────────────────►│                     │
  │                          │                        │                  │ 1. record outpoint  │
  │                          │                        │                  │    in watched_      │
  │                          │                        │                  │    sessions map     │
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
  │                          │                        │                  │     compute hashes  │
  │                          │                        │                  │     success = match?│
  │                          │                        │                  │   sign attestation  │
  │                          │                        │◄─ respond_bidirectional(attestation) ──┤
  │                          │                        │ emit RespondBidirectionalEvent         │
  │◄─ observe event ─────────┼────────────────────────┤                  │                     │
  │                          │                        │                  │                     │
  │ complete_withdraw_btc_session(session_id, attestation)               │                     │
  ├─────────────────────────►│                        │                  │                     │
  │                          │ 1. verify MPC sig      │                  │                     │
  │                          │ 2. verify hashes match │                  │                     │
  │                          │    session PDA         │                  │                     │
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

**Goal:** Split a multi-input transaction across sessions to bypass accumulation bound.

**Scenario:**

```text
Transaction needs 3 inputs (10 BTC each = 30 BTC total)
User wants: 25 BTC output, 4 BTC change, 1 BTC fee

Instead of one session (would require 26 BTC decremented):
  User creates 3 sessions, each signing 1 input
  Each session has smaller accumulation bound
  Total decremented: less than 26 BTC?
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

// 3. Create session (NO balance decrement needed for deposits)
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
```

**3) Claim Deposit:**

After the deposit transaction confirms on Bitcoin:

1. MPC observes the transaction and calls `respond_bidirectional()` on ChainSignatures
2. ChainSignatures emits `RespondBidirectionalEvent`
3. Client observes the event and calls `claim_deposit_btc_session` on Vault

```text
claim_deposit_btc_session(session_id, serialized_output, signature)
```

**Vault handling:**

```text
// 1. Verify MPC signature (same as claim_btc pattern)
// 2. Verify 6+ confirmations

// 3. Calculate actual deposit from Bitcoin state
actual_vault_outputs = actual_outputs.filter(o => o.script == VAULT_SCRIPT_PUBKEY)
actual_deposit = sum(actual_vault_outputs.map(o => o.amount))

// 4. Credit user (based on ACTUAL receipt, not session expectation)
user.solana_balance += actual_deposit

session.status = Completed
```
