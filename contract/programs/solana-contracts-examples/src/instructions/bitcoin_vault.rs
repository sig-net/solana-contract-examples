use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_lang::solana_program::secp256k1_recover::secp256k1_recover;
use borsh::BorshDeserialize;
use chain_signatures::cpi::accounts::SignRespond;
use chain_signatures::cpi::sign_respond;
use chain_signatures::SerializationFormat;
use omni_transaction::bitcoin::types::{
    Amount, EcdsaSighashType, Hash, LockTime, OutPoint, ScriptBuf, Sequence, TxIn, TxOut, Txid,
    Version, Witness,
};
use omni_transaction::{TransactionBuilder, TxBuilder, BITCOIN};

use crate::state::bitcoin::BitcoinDepositParams;
use crate::{ClaimBitcoin, DepositBitcoin};

// Your vault's Bitcoin address - MUST BE CHANGED TO YOUR ACTUAL ADDRESS
const VAULT_BTC_ADDRESS_SCRIPT: &[u8] = &[
    0x00, 0x14, // OP_0 + 20 bytes (P2WPKH)
    // Add your 20-byte pubkey hash here
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
];

pub fn deposit_bitcoin(
    ctx: Context<DepositBitcoin>,
    deposit_params: BitcoinDepositParams,
) -> Result<()> {
    // Validate at least one output goes to our vault
    let mut deposit_amount = 0u64;
    let mut found_vault_output = false;

    for output in &deposit_params.tx_outputs {
        if output.script_pubkey == VAULT_BTC_ADDRESS_SCRIPT {
            deposit_amount = deposit_amount
                .checked_add(output.amount)
                .ok_or(crate::error::ErrorCode::Overflow)?;
            found_vault_output = true;
        }
    }

    require!(
        found_vault_output,
        crate::error::ErrorCode::InvalidDestination
    );
    require!(deposit_amount > 0, crate::error::ErrorCode::ZeroDeposit);

    msg!("Bitcoin deposit: {} satoshis to vault", deposit_amount);

    // Build the Bitcoin transaction using omni_transaction
    let mut tx_inputs = Vec::new();
    for input in &deposit_params.tx_inputs {
        // Convert the byte array to hex string first
        let txid_hex = hex::encode(&input.txid);

        tx_inputs.push(TxIn {
            previous_output: OutPoint {
                txid: Txid(Hash::from_hex(&txid_hex).unwrap()),
                vout: input.vout,
            },
            script_sig: ScriptBuf::default(),
            sequence: Sequence::MAX,
            witness: Witness::default(),
        });
    }

    let mut tx_outputs = Vec::new();
    for output in &deposit_params.tx_outputs {
        tx_outputs.push(TxOut {
            value: Amount::from_sat(output.amount),
            script_pubkey: ScriptBuf(output.script_pubkey.clone()),
        });
    }

    let bitcoin_tx = TransactionBuilder::new::<BITCOIN>()
        .version(Version::Two) // SegWit
        .inputs(tx_inputs)
        .outputs(tx_outputs)
        .lock_time(LockTime::from_height(0).unwrap())
        .build();

    let mut request_ids = Vec::new();
    let path = ctx.accounts.requester.key().to_string();

    // For each input, create a different signing payload and call sign_respond
    for (i, input) in deposit_params.tx_inputs.iter().enumerate() {
        // Build signing payload for this specific input
        let signing_payload = bitcoin_tx.build_for_signing_segwit(
            EcdsaSighashType::All,
            i, // Input index
            &ScriptBuf(input.script_pubkey.clone()),
            input.amount,
        );

        // Generate request ID for this specific payload
        let request_id = generate_sign_respond_request_id(
            &ctx.accounts.requester_pda.key(),
            &signing_payload,
            0, // Bitcoin SLIP-44
            0, // key_version
            &path,
            "ECDSA",
            "bitcoin",
            &format!("input_{}", i),
        );

        request_ids.push(request_id);

        msg!("Input {} request_id: {:?}", i, request_id);

        // CPI to sign_respond for this input
        let requester_key_bytes = ctx.accounts.requester.key().to_bytes();
        let requester_bump = ctx.bumps.requester_pda;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault_authority",
            requester_key_bytes.as_ref(),
            &[requester_bump],
        ]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.chain_signatures_program.to_account_info(),
            SignRespond {
                program_state: ctx.accounts.chain_signatures_state.to_account_info(),
                requester: ctx.accounts.requester_pda.to_account_info(),
                fee_payer: ctx
                    .accounts
                    .fee_payer
                    .as_ref()
                    .map(|fp| fp.to_account_info()),
                system_program: ctx.accounts.system_program.to_account_info(),
                instructions: ctx
                    .accounts
                    .instructions
                    .as_ref()
                    .map(|i| i.to_account_info()),
                event_authority: ctx.accounts.event_authority.to_account_info(),
                program: ctx.accounts.chain_signatures_program.to_account_info(),
            },
            signer_seeds,
        );

        // Simple boolean schema for response
        let callback_schema = serde_json::to_vec(&serde_json::json!("bool"))
            .map_err(|_| crate::error::ErrorCode::SerializationError)?;

        sign_respond(
            cpi_ctx,
            signing_payload,
            0, // Bitcoin SLIP-44
            0, // key_version
            path.clone(),
            "ECDSA".to_string(),
            "bitcoin".to_string(),
            format!("input_{}", i),
            SerializationFormat::Borsh,
            vec![], // No explorer schema needed
            SerializationFormat::Borsh,
            callback_schema,
        )?;
    }

    // Store pending deposit
    let pending = &mut ctx.accounts.pending_deposit;
    pending.requester = ctx.accounts.requester.key();
    pending.deposit_amount = deposit_amount;
    pending.total_inputs = deposit_params.tx_inputs.len() as u8;
    pending.request_ids = request_ids;

    msg!(
        "Bitcoin deposit initiated: {} inputs",
        deposit_params.tx_inputs.len()
    );

    Ok(())
}

pub fn claim_bitcoin(
    ctx: Context<ClaimBitcoin>,
    request_ids: Vec<[u8; 32]>,
    serialized_outputs: Vec<Vec<u8>>,
    signatures: Vec<chain_signatures::Signature>,
) -> Result<()> {
    let pending = &ctx.accounts.pending_deposit;

    // Verify we have the right number of attestations
    require!(
        request_ids.len() == pending.total_inputs as usize,
        crate::error::ErrorCode::InvalidAttestationCount
    );
    require!(
        serialized_outputs.len() == pending.total_inputs as usize,
        crate::error::ErrorCode::InvalidAttestationCount
    );
    require!(
        signatures.len() == pending.total_inputs as usize,
        crate::error::ErrorCode::InvalidAttestationCount
    );

    // Verify ALL signatures and attestations - if ANY fail, whole tx reverts
    for i in 0..pending.total_inputs as usize {
        // Verify request_id matches
        require!(
            pending.request_ids[i] == request_ids[i],
            crate::error::ErrorCode::InvalidRequestId
        );

        // Verify MPC signature
        let message_hash = hash_message(&request_ids[i], &serialized_outputs[i]);
        verify_signature_from_address(
            &message_hash,
            &signatures[i],
            "0x00A40C2661293d5134E53Da52951A3F7767836Ef", // Your MPC signer
        )?;

        // Verify UTXO was spent (MPC returns boolean)
        let spent_confirmed: bool = BorshDeserialize::try_from_slice(&serialized_outputs[i])
            .map_err(|_| crate::error::ErrorCode::InvalidOutput)?;

        require!(spent_confirmed, crate::error::ErrorCode::TransferFailed);

        msg!("Input {} verified", i);
    }

    // ALL verified - credit the user
    let balance = &mut ctx.accounts.user_balance;
    balance.amount = balance
        .amount
        .checked_add(pending.deposit_amount)
        .ok_or(crate::error::ErrorCode::Overflow)?;

    msg!(
        "Bitcoin deposit claimed: {} satoshis",
        pending.deposit_amount
    );

    Ok(())
}

// Helper functions (same as in ERC20)
fn generate_sign_respond_request_id(
    sender: &Pubkey,
    transaction_data: &[u8],
    slip44_chain_id: u32,
    key_version: u32,
    path: &str,
    algo: &str,
    dest: &str,
    params: &str,
) -> [u8; 32] {
    use alloy_sol_types::SolValue;

    let encoded = (
        sender.to_string(),
        transaction_data,
        slip44_chain_id,
        key_version,
        path,
        algo,
        dest,
        params,
    )
        .abi_encode_packed();

    keccak::hash(&encoded).to_bytes()
}

fn hash_message(request_id: &[u8; 32], serialized_output: &[u8]) -> [u8; 32] {
    let mut data = Vec::with_capacity(32 + serialized_output.len());
    data.extend_from_slice(request_id);
    data.extend_from_slice(serialized_output);
    keccak::hash(&data).to_bytes()
}

fn verify_signature_from_address(
    message_hash: &[u8; 32],
    signature: &chain_signatures::Signature,
    expected_address: &str,
) -> Result<()> {
    require!(
        signature.recovery_id < 4,
        crate::error::ErrorCode::InvalidSignature
    );

    let mut sig_bytes = [0u8; 64];
    sig_bytes[..32].copy_from_slice(&signature.big_r.x);
    sig_bytes[32..].copy_from_slice(&signature.s);

    let recovered_pubkey = secp256k1_recover(message_hash, signature.recovery_id, &sig_bytes)
        .map_err(|_| crate::error::ErrorCode::InvalidSignature)?;

    let pubkey_bytes = recovered_pubkey.to_bytes();
    let pubkey_hash = keccak::hash(&pubkey_bytes);
    let address_bytes = &pubkey_hash.to_bytes()[12..];

    let recovered_address = format!("0x{}", hex::encode(address_bytes));

    require!(
        recovered_address.to_lowercase() == expected_address.to_lowercase(),
        crate::error::ErrorCode::InvalidSignature
    );

    Ok(())
}
