# Contract Workspace

A cross-chain vault on Solana that lets users deposit and withdraw ERC20 tokens
(from Ethereum) and Bitcoin using MPC signatures from the
[Signet](https://docs.sig.network) Chain Signatures protocol. The program never
holds private keys — all signing is delegated to a distributed MPC network.

**Program ID:** `DzSqpUpL8DJ1z3wNAFnPMKRPZQL1oEZrwwSnXkA4w8Ce`

## What the Demo Does

### ERC20 Deposit (Ethereum → Solana)

1. User calls `deposit_erc20` with the ERC20 token address, amount, and
   recipient address on Ethereum
2. The program constructs an unsigned EIP-1559 EVM transaction calling
   `IERC20.transfer(recipient, amount)` using `signet-rs` and RLP-encodes it
3. A deterministic `request_id` is computed:
   `keccak256(abi_encode_packed(sender, rlp_tx, caip2_id, key_version, path, algo, dest, params))`
   — the caller must pass the correct `request_id` and the program validates it
4. A `PendingErc20Deposit` PDA is created (seeds: `["pending_erc20_deposit", request_id]`)
   storing the requester, amount, ERC20 address, path, and request_id
5. The program CPIs into the Chain Signatures program via `sign_bidirectional`,
   with the user's `vault_authority` PDA (seeds: `["vault_authority", user_pubkey]`)
   as the signer. The derivation path = user's Solana pubkey string
6. The MPC network signs the EVM transaction and broadcasts it on Ethereum,
   executing the `transfer` on-chain
7. The MPC responds back to the Chain Signatures program with `(signature, serialized_output, request_id)`
8. User calls `claim_erc20` — the program:
   - Derives the expected ETH address on-chain from `mpc_root_public_key` +
     `vault_authority` PDA (predecessor) + path `"solana response key"` using
     epsilon derivation + `secp256k1_recover` ecmul trick (~100 CUs)
   - Recovers the signer from the MPC response signature via `secp256k1_recover`
   - Verifies recovered address matches expected address (case-insensitive)
   - Deserializes `serialized_output` as `bool`; asserts `true`
   - Credits the user's `UserErc20Balance` PDA
     (seeds: `["user_erc20_balance", user_pubkey, erc20_address]`)
   - Closes the `PendingErc20Deposit`

### ERC20 Withdrawal (Solana → Ethereum)

1. Authority calls `withdraw_erc20` with the ERC20 address, amount, and
   Ethereum recipient address
2. The program checks the user's `UserErc20Balance` and **optimistically
   decrements** it by the withdrawal amount
3. An unsigned EIP-1559 EVM transaction calling
   `IERC20.transfer(recipient, amount)` is constructed and RLP-encoded
4. A `PendingErc20Withdrawal` PDA is created
   (seeds: `["pending_erc20_withdrawal", request_id]`)
5. The program CPIs into Chain Signatures via `sign_bidirectional`, using the
   `global_vault_authority` PDA (seeds: `["global_vault_authority"]`) as signer
   with a hardcoded `"root"` derivation path — all withdrawals go through a
   single vault-wide signer
6. The MPC network signs and broadcasts the EVM transaction on Ethereum
7. User calls `complete_withdraw_erc20` — the program:
   - Derives the expected ETH address from `mpc_root_public_key` +
     `global_vault_authority` PDA (predecessor) + path `"solana response key"`
   - Verifies the MPC signature against the expected address
   - Checks for error magic prefix `[0xDE, 0xAD, 0xBE, 0xEF]` in output
   - Deserializes as `bool`:
     - If `true`: the deduction stands (withdrawal succeeded)
     - If `false` or error prefix: the balance is **refunded** to `UserErc20Balance`
   - Closes the `PendingErc20Withdrawal`

### BTC Deposit (Bitcoin → Solana)

1. User calls `deposit_btc` with Bitcoin inputs (`txid`, `vout`,
   `script_pubkey`, `value`), outputs, lock_time, caip2_id, and the vault's
   `script_pubkey`
2. The program constructs an unsigned SegWit v2 transaction using `signet-rs`
   and builds a PSBT (Partially Signed Bitcoin Transaction) with `witnessUtxo`
   metadata for each input
3. Validates that at least one output matches `vault_script_pubkey` with
   `value > 0` — this is the vault deposit amount
4. `request_id` is computed from the TXID (explorer-order serialization)
5. A `PendingBtcDeposit` PDA is created
   (seeds: `["pending_btc_deposit", request_id]`) storing requester,
   vault output amount, path, and request_id
6. The program CPIs into Chain Signatures via `sign_bidirectional` with the
   PSBT bytes, using the user's `vault_authority` PDA as signer and the user's
   Solana pubkey as the derivation path
7. The MPC network signs and broadcasts the Bitcoin transaction
8. User calls `claim_btc` — same signature verification as ERC20 (derive
   expected address, recover signer, compare). On success, credits the user's
   `UserBtcBalance` PDA (seeds: `["user_btc_balance", user_pubkey]`) and closes
   the `PendingBtcDeposit`

### BTC Withdrawal (Solana → Bitcoin)

1. Authority calls `withdraw_btc` with UTXO inputs, amount (sats), recipient
   address, fee, and vault/recipient script pubkeys
2. The program validates `sum(inputs) >= amount + fee`, checks
   `UserBtcBalance`, and **optimistically decrements** by `amount + fee`
3. An unsigned SegWit v2 transaction is built with:
   - Output 1: `recipient_script_pubkey` with `amount` sats
   - Output 2 (if `change > 0`): `vault_script_pubkey` with change
4. A PSBT is built and serialized. `request_id` is computed from the TXID
5. A `PendingBtcWithdrawal` PDA is created
   (seeds: `["pending_btc_withdrawal", request_id]`)
6. The program CPIs into Chain Signatures with the `global_vault_authority` PDA
   and hardcoded `"root"` path
7. User calls `complete_withdraw_btc` — verifies the MPC signature; if error
   prefix or `false`, refunds `amount + fee` to `UserBtcBalance`; closes the
   `PendingBtcWithdrawal`

## Deposit Lifecycle (ERC20)

```
 User                           Solana (Vault Program)          MPC Network                    Ethereum
 |                              |                               |                              |
 | 1. deposit_erc20             |                               |                              |
 |   (erc20_addr, amount,       |                               |                              |
 |    recipient, tx_params,     |                               |                              |
 |    request_id)               |                               |                              |
 |----------------------------->|                                |                              |
 |                              | build unsigned EIP-1559 tx     |                              |
 |                              | RLP-encode                     |                              |
 |                              | validate request_id            |                              |
 |                              |                                |                              |
 |                              | create PendingErc20Deposit     |                              |
 |                              |   PDA: ["pending_erc20_deposit"|                              |
 |                              |         request_id]            |                              |
 |                              |                                |                              |
 |                              | 2. CPI: sign_bidirectional     |                              |
 |                              |   signer: vault_authority PDA  |                              |
 |                              |   path: user's Solana pubkey   |                              |
 |                              |   algo: "ECDSA"                |                              |
 |                              |   dest: "ethereum"             |                              |
 |                              |-------------------------------->|                              |
 |                              |                                |                              |
 |                              |                                | 3. derive child key          |
 |                              |                                |    sign(rlp_tx)              |
 |                              |                                |    broadcast                 |
 |                              |                                |----- ERC20 transfer -------->|
 |                              |                                |<-------- receipt ------------|
 |                              |                                |                              |
 |                              |                                | 4. respond to Solana         |
 |                              |                                |    (signature,               |
 |                              |                                |     serialized_output,       |
 |                              |                                |     request_id)              |
 |                              |<-------------------------------|                              |
 |                              |                                |                              |
 | 5. claim_erc20               |                                |                              |
 |   (request_id, signature,    |                                |                              |
 |    serialized_output)        |                                |                              |
 |----------------------------->|                                |                              |
 |                              | derive expected ETH address:   |                              |
 |                              |   predecessor = vault_authority|                              |
 |                              |   path = "solana response key" |                              |
 |                              |   epsilon = keccak256(...)      |                              |
 |                              |   child = mpcRoot + epsilon*G  |                              |
 |                              |   addr = keccak256(child)[12..]|                              |
 |                              |                                |                              |
 |                              | secp256k1_recover(hash, sig)   |                              |
 |                              |   → recovered ETH address      |                              |
 |                              | assert recovered == expected   |                              |
 |                              |                                |                              |
 |                              | deserialize output as bool     |                              |
 |                              | assert output == true          |                              |
 |                              |                                |                              |
 |                              | credit UserErc20Balance        |                              |
 |                              |   PDA: ["user_erc20_balance",  |                              |
 |                              |         user, erc20_addr]      |                              |
 |                              |                                |                              |
 |                              | close PendingErc20Deposit      |                              |
 |                              |                                |                              |
```

## Account State

### VaultConfig

Singleton storing the MPC root public key. Created once via `initialize_config`.

```rust
// PDA: ["vault_config"]
pub struct VaultConfig {
    pub mpc_root_public_key: [u8; 64], // uncompressed secp256k1 (no 0x04 prefix)
}
```

### ERC20 Accounts

```rust
// PDA: ["pending_erc20_deposit", request_id]
pub struct PendingErc20Deposit {
    pub requester: Pubkey,
    pub amount: u128,
    pub erc20_address: [u8; 20],
    pub path: String,           // max 64 chars
    pub request_id: [u8; 32],
}

// PDA: ["pending_erc20_withdrawal", request_id]
pub struct PendingErc20Withdrawal {
    pub requester: Pubkey,
    pub amount: u128,
    pub erc20_address: [u8; 20],
    pub recipient_address: [u8; 20],
    pub path: String,           // max 64 chars
    pub request_id: [u8; 32],
}

// PDA: ["user_erc20_balance", user_pubkey, erc20_address]
pub struct UserErc20Balance {
    pub amount: u128,           // per-user, per-token
}
```

### Bitcoin Accounts

```rust
// PDA: ["pending_btc_deposit", request_id]
pub struct PendingBtcDeposit {
    pub requester: Pubkey,
    pub amount: u64,            // sats
    pub path: String,           // max 64 chars
    pub request_id: [u8; 32],
}

// PDA: ["pending_btc_withdrawal", request_id]
pub struct PendingBtcWithdrawal {
    pub requester: Pubkey,
    pub amount: u64,            // sats
    pub fee: u64,               // sats
    pub recipient_address: String, // max 64 chars
    pub path: String,           // max 64 chars
    pub request_id: [u8; 32],
}

// PDA: ["user_btc_balance", user_pubkey]
pub struct UserBtcBalance {
    pub amount: u64,            // sats, per-user (no token distinction)
}
```

### Authority PDAs

| PDA | Seeds | Used for |
|-----|-------|----------|
| vault_authority | `["vault_authority", user_pubkey]` | Per-user signer for deposits |
| global_vault_authority | `["global_vault_authority"]` | Shared signer for all withdrawals |

## Key Derivation

All address derivation uses the sig.network v2.0.0 epsilon scheme:

```
epsilon = keccak256("sig.network v2.0.0 epsilon derivation:solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:{predecessorId}:{path}")
childPublicKey = mpcRootKey + (epsilon × G)
ethereumAddress = keccak256(childPublicKey)[12..32]
```

**Deposits:** `predecessorId` = user's `vault_authority` PDA, `path` = user's Solana pubkey string.
Each user gets a unique derived EVM signer.

**Withdrawals:** `predecessorId` = `global_vault_authority` PDA, `path` = `"root"`.
All withdrawals go through a single vault-wide signer.

**Signature verification path:** Both deposits and withdrawals verify the MPC
response signature using `path` = `"solana response key"` (a hardcoded constant
distinct from the request path). The program derives the expected ETH address
from this path + the relevant predecessor, then compares it to the address
recovered from the MPC signature via `secp256k1_recover`.

### EC Multiplication Optimization

Computing `epsilon × G` on-chain normally costs ~5M CUs. The program uses an
optimization that abuses `secp256k1_recover` to do it in ~100 CUs:

```
message_hash = 0
r = G.x  (generator point x-coordinate)
s = r × scalar (mod n)
secp256k1_recover(0, recovery_id, r || s) → scalar × G
```

This works because the recovery formula simplifies to `Q = r⁻¹(s·R - 0·G) = scalar × G`
when the message hash is zero and `r = G.x`.

## Prerequisites

- Install dependencies: `yarn install`
- Copy `.env.example` to `.env` and configure:
  - `MPC_ROOT_KEY` or `BASE_PUBLIC_KEY`
  - `SOLANA_RPC_URL`, `SOLANA_PRIVATE_KEY`
  - `BITCOIN_NETWORK` (regtest/testnet/mainnet)
  - `INFURA_API_KEY` for EVM chains

### Bitcoin Setup (Regtest)

For local Bitcoin testing with instant block mining:

```bash
# Clone the Bitcoin regtest repository
git clone https://github.com/Pessina/bitcoin-regtest.git
cd bitcoin-regtest

# Start Bitcoin Core in regtest mode
yarn docker:dev

# Bitcoin RPC will be available at: http://localhost:18443
# Web UI at: http://localhost:5173
```

Set in `.env`:
```
BITCOIN_NETWORK=regtest
```

**Network Options:**
- `regtest` - Local Bitcoin Core (addresses: `bcrt1q...`) - Auto-mines blocks, instant funding
- `testnet` - Bitcoin testnet4 (addresses: `tb1q...`) - Requires external faucet
- `mainnet` - Bitcoin mainnet (addresses: `bc1q...`) - Production use only

## Build, Type Check, and Test

- Compile programs: `anchor build`
- Deploy to devnet: `anchor deploy --provider.cluster devnet`
- Type check and lint: `yarn lint`
- Run tests: `anchor test --skip-build --skip-deploy`
- The TypeScript integration tests automatically ensure the on-chain `vault_config`
  account is initialized with the derived MPC root signer. If the account already
  exists with the correct key, the setup skips re-initialization.

## Key Management

- If you have access to the private key, set `MPC_ROOT_PRIVATE_KEY`; the root public key is derived automatically.
- If the private key is unavailable, provide the uncompressed key in `MPC_ROOT_PUBLIC_KEY` (65-byte hex, prefixed with `04`).
- Ensure the on-chain contract is initialized with the same base public key you load here before interacting with it.

## Proposed Improvement: Intent-Encoded Derivation Paths

### Overview

Turn a single cross-chain deposit into one or more pre-authorized Solana actions by encoding user intent directly into the MPC key derivation path.

Today the `path` parameter in `deposit_*` is set to the user's Solana pubkey — but it's arbitrary. By setting `path = keccak256(abi.encode(actionType, params...))`, the deposit address itself becomes a cryptographic commitment to a specific subsequent action on Solana.

### How It Works

**User (off-chain):**
1. Decide the post-deposit action, e.g. `transfer(20, 0x123, 0x456)`
2. Compute `path = keccak256(abi.encode("transfer", 20, 0x123, 0x456))`
3. Derive the deposit address for that path (deterministic via epsilon derivation)
4. Deposit funds to that address on Ethereum/Bitcoin
5. Publish the action pre-image as calldata in the deposit tx (so any relayer can index it)

**Relayer (single Solana tx, multiple instructions):**
1. Index the deposit tx calldata to recover the action pre-image
2. Call `deposit_*` / `claim_*` with the intent-encoded path → credits vault balance
3. Execute the pre-authorized action (transfer, swap, etc.)
4. The program verifies `keccak256(provided_action_params) == path` before executing

### Properties

- **No MPC-layer changes** — the MPC network already supports arbitrary paths
- **No extra on-chain state for intents** — the deposit address IS the intent
- **Permissionless relaying** — anyone who knows the pre-image can execute; the outcome is deterministic
- **Front-running is harmless** — whoever relays, the same action executes
- **Composable** — the path can encode a sequence of actions, turning 1 deposit into N on-chain operations

### Contract Changes Required

- An action schema defining supported actions (transfer, swap, etc.)
- Path verification: `keccak256(provided_action_params) == path`
- Action execution logic triggered after claim
- Atomicity enforcement: claim + action execution must happen in the same transaction (e.g. a `claim_and_execute` instruction)
- A cancellation/timeout mechanism for deposits to intent-encoded addresses

### Open Questions

- **Cancellation:** once funds are at the derived address, the user can't easily reclaim them — a timeout or cancel-path mechanism is needed
- **Path encoding format:** must be canonical for deterministic hashing; ABI encoding is a good default (unambiguous, well-tooled, fits 64-char path limit as hex hash)
- **Multi-action intents:** `path = keccak256(action1 || action2 || ...)` enables chaining a whole sequence from a single deposit
