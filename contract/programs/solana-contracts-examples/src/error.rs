use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid chain signatures program")]
    InvalidChainSignaturesProgram,
    #[msg("Serialization error")]
    SerializationError,
    #[msg("Function not found in ABI")]
    FunctionNotFound,
    #[msg("Invalid request ID")]
    InvalidRequestId,
    #[msg("Invalid signature")]
    InvalidSignature,
    #[msg("Transfer failed")]
    TransferFailed,
    #[msg("Invalid output format")]
    InvalidOutput,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid address")]
    InvalidAddress,
    #[msg("Schema size exceeds maximum allowed")]
    SchemaTooLarge,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Underflow error")]
    Underflow,
    #[msg("Transaction not found in history")]
    TransactionNotFound,
    #[msg("Invalid destination address")]
    InvalidDestination,
    #[msg("Deposit amount must be greater than zero")]
    ZeroDeposit,
    #[msg("Invalid number of attestations")]
    InvalidAttestationCount,
}
