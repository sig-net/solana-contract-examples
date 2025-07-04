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
}
