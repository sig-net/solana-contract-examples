use alloy_sol_types::sol;
use anchor_lang::prelude::*;

sol! {
    #[sol(abi)]
    interface IERC20 {
        function transfer(address to, uint256 amount) external returns (bool);
    }
}

#[account]
#[derive(InitSpace)]
pub struct PendingErc20Deposit {
    pub requester: Pubkey,
    pub amount: u128,
    pub erc20_address: [u8; 20],
    #[max_len(64)]
    pub path: String,
    pub request_id: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct PendingErc20Withdrawal {
    pub requester: Pubkey,
    pub amount: u128,
    pub erc20_address: [u8; 20],
    pub recipient_address: [u8; 20],
    #[max_len(64)]
    pub path: String,
    pub request_id: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct UserErc20Balance {
    pub amount: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct EvmTransactionParams {
    pub value: u128,
    pub gas_limit: u128,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub nonce: u64,
    pub chain_id: u64,
}
