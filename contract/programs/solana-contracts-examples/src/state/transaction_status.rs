use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub enum TransactionStatus {
    Pending,
    Completed,
    Failed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum TransactionType {
    Deposit,
    Withdrawal,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TransactionRecord {
    pub request_id: [u8; 32],
    pub transaction_type: TransactionType,
    pub status: TransactionStatus,
    pub amount: u128,
    pub erc20_address: [u8; 20],
    pub recipient_address: [u8; 20], // For withdrawals, empty for deposits
    pub timestamp: i64,
    pub ethereum_tx_hash: Option<[u8; 32]>, // Optional Ethereum transaction hash
}

impl TransactionRecord {
    pub const SIZE: usize = 32 + // request_id
        1 + // transaction_type enum
        1 + // status enum
        16 + // amount
        20 + // erc20_address
        20 + // recipient_address
        8 + // timestamp
        1 + 32; // optional ethereum_tx_hash
}

// PDA for storing user transaction history
#[account]
pub struct UserTransactionHistory {
    pub deposits: Vec<TransactionRecord>,
    pub withdrawals: Vec<TransactionRecord>,
}

impl UserTransactionHistory {
    pub const MAX_TRANSACTIONS: usize = 5; // Store last 5 of each type

    pub fn space() -> usize {
        8 + // discriminator
        4 + (Self::MAX_TRANSACTIONS * TransactionRecord::SIZE) + // deposits vector
        4 + (Self::MAX_TRANSACTIONS * TransactionRecord::SIZE) // withdrawals vector
    }

    // pub fn add_deposit(&mut self, record: TransactionRecord) {
    //     // Add to beginning for newest first ordering
    //     self.deposits.insert(0, record);

    //     // Keep only last MAX_TRANSACTIONS
    //     if self.deposits.len() > Self::MAX_TRANSACTIONS {
    //         self.deposits.truncate(Self::MAX_TRANSACTIONS);
    //     }
    // }

    // pub fn add_withdrawal(&mut self, record: TransactionRecord) {
    //     // Add to beginning for newest first ordering
    //     self.withdrawals.insert(0, record);

    //     // Keep only last MAX_TRANSACTIONS
    //     if self.withdrawals.len() > Self::MAX_TRANSACTIONS {
    //         self.withdrawals.truncate(Self::MAX_TRANSACTIONS);
    //     }
    // }

    // pub fn update_deposit_status(
    //     &mut self,
    //     request_id: &[u8; 32],
    //     new_status: TransactionStatus,
    //     ethereum_tx_hash: Option<[u8; 32]>,
    // ) -> Result<()> {
    //     for deposit in &mut self.deposits {
    //         if deposit.request_id == *request_id {
    //             deposit.status = new_status;
    //             if ethereum_tx_hash.is_some() {
    //                 deposit.ethereum_tx_hash = ethereum_tx_hash;
    //             }
    //             return Ok(());
    //         }
    //     }
    //     err!(ErrorCode::TransactionNotFound)
    // }

    // pub fn update_withdrawal_status(
    //     &mut self,
    //     request_id: &[u8; 32],
    //     new_status: TransactionStatus,
    //     ethereum_tx_hash: Option<[u8; 32]>,
    // ) -> Result<()> {
    //     for withdrawal in &mut self.withdrawals {
    //         if withdrawal.request_id == *request_id {
    //             withdrawal.status = new_status;
    //             if ethereum_tx_hash.is_some() {
    //                 withdrawal.ethereum_tx_hash = ethereum_tx_hash;
    //             }
    //             return Ok(());
    //         }
    //     }
    //     err!(ErrorCode::TransactionNotFound)
    // }
}

#[error_code]
pub enum ErrorCode {
    #[msg("Transaction not found in history")]
    TransactionNotFound,
}
