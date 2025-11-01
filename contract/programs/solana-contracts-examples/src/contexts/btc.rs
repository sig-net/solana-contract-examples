use crate::constants::*;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(request_id: [u8; 32], requester: Pubkey, inputs: Vec<BtcInput>, outputs: Vec<BtcOutput>, tx_params: BtcDepositParams)]
pub struct DepositBtc<'info> {
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
        space = 8 + PendingBtcDeposit::INIT_SPACE,
        seeds = [
            b"pending_btc_deposit",
            request_id.as_ref()
        ],
        bump
    )]
    pub pending_deposit: Account<'info, PendingBtcDeposit>,

    #[account(mut)]
    pub fee_payer: Option<Signer<'info>>,

    /// CHECK: Chain signatures state
    #[account(
        mut,
        seeds = [CHAIN_SIGNATURES_STATE_SEED],
        bump,
        seeds::program = chain_signatures_program.key()
    )]
    pub chain_signatures_state: AccountInfo<'info>,

    /// CHECK: Event authority for CPI events
    #[account(
        seeds = [b"__event_authority"],
        bump,
        seeds::program = chain_signatures_program.key()
    )]
    pub event_authority: AccountInfo<'info>,

    pub chain_signatures_program: Program<'info, ::chain_signatures::program::ChainSignatures>,
    pub system_program: Program<'info, System>,
    pub instructions: Option<AccountInfo<'info>>,

    #[account(
        seeds = [b"vault_config"],
        bump
    )]
    pub config: Account<'info, VaultConfig>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + UserTransactionHistory::INIT_SPACE,
        seeds = [
            b"user_transaction_history",
            requester.as_ref()
        ],
        bump
    )]
    pub transaction_history: Account<'info, UserTransactionHistory>,
}

#[derive(Accounts)]
#[instruction(request_id: [u8; 32])]
pub struct ClaimBtc<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"pending_btc_deposit",
            &request_id
        ],
        bump,
        close = payer
    )]
    pub pending_deposit: Account<'info, PendingBtcDeposit>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + UserBtcBalance::INIT_SPACE,
        seeds = [
            b"user_btc_balance",
            pending_deposit.requester.as_ref()
        ],
        bump
    )]
    pub user_balance: Account<'info, UserBtcBalance>,

    pub system_program: Program<'info, System>,

    #[account(
        seeds = [b"vault_config"],
        bump
    )]
    pub config: Account<'info, VaultConfig>,

    #[account(
        mut,
        seeds = [
            b"user_transaction_history",
            pending_deposit.requester.as_ref()
        ],
        bump
    )]
    pub transaction_history: Account<'info, UserTransactionHistory>,
}

#[derive(Accounts)]
#[instruction(request_id: [u8; 32], inputs: Vec<BtcInput>, amount: u64, recipient_address: String, tx_params: BtcWithdrawParams)]
pub struct WithdrawBtc<'info> {
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
        space = 8 + PendingBtcWithdrawal::INIT_SPACE,
        seeds = [
            b"pending_btc_withdrawal",
            request_id.as_ref()
        ],
        bump
    )]
    pub pending_withdrawal: Account<'info, PendingBtcWithdrawal>,

    #[account(
        mut,
        seeds = [
            b"user_btc_balance",
            authority.key().as_ref()
        ],
        bump,
        constraint = user_balance.amount >= amount
    )]
    pub user_balance: Account<'info, UserBtcBalance>,

    #[account(mut)]
    pub fee_payer: Option<Signer<'info>>,

    /// CHECK: Chain signatures state
    #[account(
        mut,
        seeds = [CHAIN_SIGNATURES_STATE_SEED],
        bump,
        seeds::program = chain_signatures_program.key()
    )]
    pub chain_signatures_state: AccountInfo<'info>,

    /// CHECK: Event authority for CPI events
    #[account(
        seeds = [b"__event_authority"],
        bump,
        seeds::program = chain_signatures_program.key()
    )]
    pub event_authority: AccountInfo<'info>,

    pub chain_signatures_program: Program<'info, ::chain_signatures::program::ChainSignatures>,
    pub system_program: Program<'info, System>,
    pub instructions: Option<AccountInfo<'info>>,

    #[account(
        seeds = [b"vault_config"],
        bump
    )]
    pub config: Account<'info, VaultConfig>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + UserTransactionHistory::INIT_SPACE,
        seeds = [
            b"user_transaction_history",
            authority.key().as_ref()
        ],
        bump
    )]
    pub transaction_history: Account<'info, UserTransactionHistory>,
}

#[derive(Accounts)]
#[instruction(request_id: [u8; 32])]
pub struct CompleteWithdrawBtc<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"pending_btc_withdrawal",
            &request_id
        ],
        bump,
        close = payer
    )]
    pub pending_withdrawal: Account<'info, PendingBtcWithdrawal>,

    #[account(
        mut,
        seeds = [
            b"user_btc_balance",
            pending_withdrawal.requester.as_ref()
        ],
        bump
    )]
    pub user_balance: Account<'info, UserBtcBalance>,

    pub system_program: Program<'info, System>,

    #[account(
        seeds = [b"vault_config"],
        bump
    )]
    pub config: Account<'info, VaultConfig>,

    #[account(
        mut,
        seeds = [
            b"user_transaction_history",
            pending_withdrawal.requester.as_ref()
        ],
        bump
    )]
    pub transaction_history: Account<'info, UserTransactionHistory>,
}
