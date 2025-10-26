use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    pub mpc_root_signer_address: [u8; 20],
}
