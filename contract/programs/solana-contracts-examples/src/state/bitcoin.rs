use anchor_lang::prelude::*;

#[account]
pub struct PendingBitcoinDeposit {
    pub requester: Pubkey,
    pub deposit_amount: u64, // Satoshis going to our vault
    pub total_inputs: u8,
    pub request_ids: Vec<[u8; 32]>, // One per input
}

impl PendingBitcoinDeposit {
    pub fn space() -> usize {
        8 + // discriminator
        32 + // requester
        8 + // deposit_amount
        1 + // total_inputs
        4 + (32 * 10) // request_ids vec (support up to 10 inputs)
    }
}

#[account]
pub struct UserBitcoinBalance {
    pub amount: u64, // satoshis
}

impl UserBitcoinBalance {
    pub fn space() -> usize {
        8 + // discriminator
        8 // amount
    }
}

// Bitcoin transaction parameters
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BitcoinDepositParams {
    pub tx_inputs: Vec<BitcoinTxInput>,
    pub tx_outputs: Vec<BitcoinTxOutput>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BitcoinTxInput {
    pub txid: [u8; 32],
    pub vout: u32,
    pub amount: u64, // satoshis
    pub script_pubkey: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BitcoinTxOutput {
    pub amount: u64, // satoshis
    pub script_pubkey: Vec<u8>,
}
