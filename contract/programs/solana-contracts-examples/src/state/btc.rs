use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BtcInput {
    pub txid: [u8; 32],
    pub vout: u32,
    pub script_pubkey: Vec<u8>,
    pub value: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BtcOutput {
    pub script_pubkey: Vec<u8>,
    pub value: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BtcDepositParams {
    pub lock_time: u32,
    pub caip2_id: String,
    pub vault_script_pubkey: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BtcWithdrawParams {
    pub lock_time: u32,
    pub caip2_id: String,
    pub vault_script_pubkey: Vec<u8>,
    pub recipient_script_pubkey: Vec<u8>,
    pub fee: u64,
}

#[account]
#[derive(InitSpace)]
pub struct PendingBtcDeposit {
    pub requester: Pubkey,
    pub amount: u64,
    #[max_len(64)]
    pub path: String,
    pub request_id: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct PendingBtcWithdrawal {
    pub requester: Pubkey,
    pub amount: u64,
    pub fee: u64,
    #[max_len(64)]
    pub recipient_address: String,
    #[max_len(64)]
    pub path: String,
    pub request_id: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct UserBtcBalance {
    pub amount: u64,
}
