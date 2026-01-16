const SEPOLIA_EXPLORER_URL = 'https://sepolia.etherscan.io';

export function getTransactionExplorerUrl(transactionHash: string): string {
  return `${SEPOLIA_EXPLORER_URL}/tx/${transactionHash}`;
}

export function getSolanaExplorerUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}?cluster=devnet`;
}
