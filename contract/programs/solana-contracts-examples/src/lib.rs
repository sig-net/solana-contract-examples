#![recursion_limit = "512"]
use anchor_lang::prelude::*;

pub mod constants;
pub mod contexts;
pub mod crypto;
pub mod error;
pub mod instructions;
pub mod state;

use ::chain_signatures::Signature;
pub use constants::*;
pub use contexts::*;
pub use state::*;

declare_id!("DzSqpUpL8DJ1z3wNAFnPMKRPZQL1oEZrwwSnXkA4w8Ce");

#[program]
pub mod solana_core_contracts {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        mpc_root_public_key: [u8; 64],
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.mpc_root_public_key = mpc_root_public_key;
        Ok(())
    }

    pub fn deposit_erc20(
        ctx: Context<DepositErc20>,
        request_id: [u8; 32],
        requester: Pubkey,
        erc20_address: [u8; 20],
        recipient_address: [u8; 20],
        amount: u128,
        tx_params: EvmTransactionParams,
    ) -> Result<()> {
        instructions::erc20_vault::deposit_erc20(
            ctx,
            request_id,
            requester,
            erc20_address,
            recipient_address,
            amount,
            tx_params,
        )
    }

    pub fn claim_erc20(
        ctx: Context<ClaimErc20>,
        request_id: [u8; 32],
        serialized_output: Vec<u8>,
        signature: Signature,
        ethereum_tx_hash: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::erc20_vault::claim_erc20(
            ctx,
            request_id,
            serialized_output,
            signature,
            ethereum_tx_hash,
        )
    }

    pub fn withdraw_erc20(
        ctx: Context<WithdrawErc20>,
        request_id: [u8; 32],
        erc20_address: [u8; 20],
        amount: u128,
        recipient_address: [u8; 20],
        tx_params: EvmTransactionParams,
    ) -> Result<()> {
        instructions::erc20_vault::withdraw_erc20(
            ctx,
            request_id,
            erc20_address,
            amount,
            recipient_address,
            tx_params,
        )
    }

    pub fn complete_withdraw_erc20(
        ctx: Context<CompleteWithdrawErc20>,
        request_id: [u8; 32],
        serialized_output: Vec<u8>,
        signature: Signature,
        ethereum_tx_hash: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::erc20_vault::complete_withdraw_erc20(
            ctx,
            request_id,
            serialized_output,
            signature,
            ethereum_tx_hash,
        )
    }

    pub fn deposit_btc(
        ctx: Context<DepositBtc>,
        request_id: [u8; 32],
        requester: Pubkey,
        inputs: Vec<BtcInput>,
        outputs: Vec<BtcOutput>,
        tx_params: BtcDepositParams,
    ) -> Result<()> {
        instructions::btc_vault::deposit_btc(ctx, request_id, requester, inputs, outputs, tx_params)
    }

    pub fn claim_btc(
        ctx: Context<ClaimBtc>,
        request_id: [u8; 32],
        serialized_output: Vec<u8>,
        signature: Signature,
        bitcoin_tx_hash: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::btc_vault::claim_btc(
            ctx,
            request_id,
            serialized_output,
            signature,
            bitcoin_tx_hash,
        )
    }

    pub fn withdraw_btc(
        ctx: Context<WithdrawBtc>,
        request_id: [u8; 32],
        inputs: Vec<BtcInput>,
        amount: u64,
        recipient_address: String,
        tx_params: BtcWithdrawParams,
    ) -> Result<()> {
        instructions::btc_vault::withdraw_btc(
            ctx,
            request_id,
            inputs,
            amount,
            recipient_address,
            tx_params,
        )
    }

    pub fn complete_withdraw_btc(
        ctx: Context<CompleteWithdrawBtc>,
        request_id: [u8; 32],
        serialized_output: Vec<u8>,
        signature: Signature,
        bitcoin_tx_hash: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::btc_vault::complete_withdraw_btc(
            ctx,
            request_id,
            serialized_output,
            signature,
            bitcoin_tx_hash,
        )
    }
}
