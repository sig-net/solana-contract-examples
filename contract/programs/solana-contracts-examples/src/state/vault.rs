use alloy_sol_types::sol;
use anchor_lang::prelude::*;

// Program-wide configuration stored at a fixed PDA
#[account]
pub struct VaultConfig {
    pub mpc_root_signer_address: [u8; 20],
}

impl VaultConfig {
    pub const fn space() -> usize {
        8 +  // discriminator
        20 // mpc_root_signer_address
    }
}

// Add ERC20 interface
sol! {
    #[sol(abi)]
    interface IERC20 {
        function transfer(address to, uint256 amount) external returns (bool);
    }
}

// PDA for storing pending ERC20 deposits
#[account]
pub struct PendingErc20Deposit {
    pub requester: Pubkey,
    pub amount: u128,
    pub erc20_address: [u8; 20],
    pub path: String,
    pub request_id: [u8; 32],
}

impl PendingErc20Deposit {
    pub const MAX_PATH_LEN: usize = 64;

    pub fn space() -> usize {
        8 + // discriminator
        32 + // requester
        16 + // amount (u128)
        20 + // erc20_address
        4 + Self::MAX_PATH_LEN + // path string
        32 // request_id
    }
}

#[account]
pub struct PendingErc20Withdrawal {
    pub requester: Pubkey,
    pub amount: u128,
    pub erc20_address: [u8; 20],
    pub recipient_address: [u8; 20],
    pub path: String,
    pub request_id: [u8; 32],
}

impl PendingErc20Withdrawal {
    pub const fn space() -> usize {
        8 +  // discriminator
        32 + // requester
        16 + // amount (u128)
        20 + // erc20_address
        20 + // recipient_address
        4 + 64 + // path (string with max length)
        32 // request_id
    }
}

// PDA for storing user ERC20 balances
#[account]
pub struct UserErc20Balance {
    pub amount: u128,
}

impl UserErc20Balance {
    pub fn space() -> usize {
        8 + // discriminator
        16 // amount (u128)
    }
}

// Transaction parameters for EVM
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct EvmTransactionParams {
    pub value: u128,
    pub gas_limit: u128,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub nonce: u64,
    pub chain_id: u64,
}
