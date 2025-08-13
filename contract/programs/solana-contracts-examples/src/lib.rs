#![recursion_limit = "512"]
use anchor_lang::prelude::*;

pub mod constants;
pub mod cpi;
pub mod error;
pub mod instructions;
pub mod state;

pub use constants::*;
pub use state::*;
pub mod schema_helper;
use ::chain_signatures::Signature;

declare_id!("3si68i2yXFAGy5k8BpqGpPJR5wE27id1Jenx3uN8GCws");

#[program]
pub mod solana_core_contracts {
    use super::*;

    pub fn process_deposit(ctx: Context<ProcessVault>, tx: VaultTransaction) -> Result<[u8; 32]> {
        instructions::process_vault::process_deposit(ctx, tx)
    }

    pub fn process_withdraw(ctx: Context<ProcessVault>, tx: VaultTransaction) -> Result<[u8; 32]> {
        instructions::process_vault::process_withdraw(ctx, tx)
    }

    pub fn sign_deposit_transaction(
        ctx: Context<SignVaultTransaction>,
        tx: VaultTransaction,
        signing_params: SigningParams,
    ) -> Result<()> {
        instructions::sign_vault::sign_deposit_transaction(ctx, tx, signing_params)
    }

    pub fn deposit_erc20(
        ctx: Context<DepositErc20>,
        request_id: [u8; 32],
        requester: Pubkey,
        erc20_address: [u8; 20],
        amount: u128,
        tx_params: EvmTransactionParams,
    ) -> Result<()> {
        instructions::erc20_vault::deposit_erc20(
            ctx,
            request_id,
            requester,
            erc20_address,
            amount,
            tx_params,
        )
    }

    pub fn claim_erc20(
        ctx: Context<ClaimErc20>,
        request_id: [u8; 32],
        serialized_output: Vec<u8>,
        signature: Signature,
    ) -> Result<()> {
        instructions::erc20_vault::claim_erc20(ctx, request_id, serialized_output, signature)
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
    ) -> Result<()> {
        instructions::erc20_vault::complete_withdraw_erc20(
            ctx,
            request_id,
            serialized_output,
            signature,
        )
    }

    pub fn sign_withdraw_transaction(
        ctx: Context<SignVaultTransaction>,
        tx: VaultTransaction,
        signing_params: SigningParams,
    ) -> Result<()> {
        instructions::sign_vault::sign_withdraw_transaction(ctx, tx, signing_params)
    }
}

#[derive(Accounts)]
#[instruction(request_id: [u8; 32], requester: Pubkey, erc20_address: [u8; 20], amount: u128, tx_params: EvmTransactionParams)]
pub struct DepositErc20<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault_authority", requester.as_ref()],
        bump
    )]
    pub requester_pda: SystemAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = PendingErc20Deposit::space(),
        seeds = [
            b"pending_erc20_deposit",
            request_id.as_ref()
        ],
        bump
    )]
    pub pending_deposit: Account<'info, PendingErc20Deposit>,

    #[account(mut)]
    pub fee_payer: Option<Signer<'info>>,

    /// CHECK: Chain signatures state
    #[account(
        mut,
        seeds = [crate::constants::CHAIN_SIGNATURES_STATE_SEED],
        bump,
        seeds::program = chain_signatures_program.key()
    )]
    pub chain_signatures_state: AccountInfo<'info>,

    /// CHECK: Event authority for CPI events, PDA with seed "__event_authority"
    #[account(
        seeds = [b"__event_authority"],
        bump,
        seeds::program = chain_signatures_program.key()
    )]
    pub event_authority: AccountInfo<'info>,

    pub chain_signatures_program:
        Program<'info, ::chain_signatures::program::ChainSignaturesProject>,
    pub system_program: Program<'info, System>,
    pub instructions: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
#[instruction(request_id: [u8; 32])]
pub struct ClaimErc20<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"pending_erc20_deposit",
            &request_id
        ],
        bump,
        close = payer
    )]
    pub pending_deposit: Account<'info, PendingErc20Deposit>,

    #[account(
        init_if_needed,
        payer = payer,
        space = UserErc20Balance::space(),
        seeds = [
            b"user_erc20_balance",
            pending_deposit.requester.as_ref(),
            &pending_deposit.erc20_address
        ],
        bump
    )]
    pub user_balance: Account<'info, UserErc20Balance>,

    pub system_program: Program<'info, System>,
}

// Add the contexts:
#[derive(Accounts)]
#[instruction(request_id: [u8; 32], erc20_address: [u8; 20], amount: u128, recipient_address: [u8; 20], tx_params: EvmTransactionParams)]
pub struct WithdrawErc20<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"global_vault_authority"],
        bump
    )]
    /// CHECK: This is a PDA that will be used as a signer
    pub requester: AccountInfo<'info>,

    #[account(
        init,
        payer = authority,
        space = PendingErc20Withdrawal::space(),
        seeds = [
            b"pending_erc20_withdrawal",
            request_id.as_ref()
        ],
        bump
    )]
    pub pending_withdrawal: Account<'info, PendingErc20Withdrawal>,

    #[account(
        mut,
        seeds = [
            b"user_erc20_balance",
            authority.key().as_ref(),
            &erc20_address
        ],
        bump,
        constraint = user_balance.amount >= amount
    )]
    pub user_balance: Account<'info, UserErc20Balance>,

    #[account(mut)]
    pub fee_payer: Option<Signer<'info>>,

    /// CHECK: Chain signatures state
    #[account(
        mut,
        seeds = [crate::constants::CHAIN_SIGNATURES_STATE_SEED],
        bump,
        seeds::program = chain_signatures_program.key()
    )]
    pub chain_signatures_state: AccountInfo<'info>,

    /// CHECK: Event authority for CPI events, PDA with seed "__event_authority"
    #[account(
        seeds = [b"__event_authority"],
        bump,
        seeds::program = chain_signatures_program.key()
    )]
    pub event_authority: AccountInfo<'info>,

    pub chain_signatures_program:
        Program<'info, ::chain_signatures::program::ChainSignaturesProject>,
    pub system_program: Program<'info, System>,
    pub instructions: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
#[instruction(request_id: [u8; 32])]
pub struct CompleteWithdrawErc20<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"pending_erc20_withdrawal",
            &request_id
        ],
        bump,
        close = payer
    )]
    pub pending_withdrawal: Account<'info, PendingErc20Withdrawal>,

    #[account(
        mut,
        seeds = [
            b"user_erc20_balance",
            pending_withdrawal.requester.as_ref(),
            &pending_withdrawal.erc20_address
        ],
        bump
    )]
    pub user_balance: Account<'info, UserErc20Balance>,

    pub system_program: Program<'info, System>,
}
