import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { ethers } from 'ethers';
import { toBytes } from 'viem';

import type { EvmTransactionRequest } from '@/lib/types/shared.types';
import { buildErc20TransferTx } from '@/lib/evm/tx-builder';
import { initializeRelayerSetup } from '@/lib/utils/relayer-setup';
import { generateRequestId, evmParamsToProgram } from '@/lib/program/utils';
import { SERVICE_CONFIG } from '@/lib/constants/service.config';
import {
  VAULT_ETHEREUM_ADDRESS,
  deriveVaultAuthorityPda,
  derivePendingDepositPda,
  derivePendingWithdrawalPda,
} from '@/lib/constants/addresses';

export async function handleDeposit(args: {
  userAddress: string;
  erc20Address: string;
  ethereumAddress: string;
}) {
  const { userAddress, erc20Address, ethereumAddress } = args;

  const { orchestrator, provider, relayerWallet } =
    await initializeRelayerSetup({
      operationName: 'DEPOSIT',
      eventTimeoutMs: 60000,
    });
  const bridgeContract = orchestrator.getBridgeContract();

  const userPublicKey = new PublicKey(userAddress);
  const [vaultAuthority] = deriveVaultAuthorityPda(userPublicKey);

  await new Promise(resolve => setTimeout(resolve, 12000));

  const actualAmount = await monitorTokenBalance(
    ethereumAddress,
    erc20Address,
    provider,
  );
  if (!actualAmount) return { ok: false, error: 'No token balance detected' };

  const randomReduction = BigInt(Math.floor(Math.random() * 100) + 1);
  const processAmount =
    actualAmount > randomReduction
      ? actualAmount - randomReduction
      : actualAmount;

  const path = userAddress;
  const erc20AddressBytes = Array.from(toBytes(erc20Address));

  const txRequest: EvmTransactionRequest = await buildErc20TransferTx({
    provider,
    from: ethereumAddress,
    erc20Address,
    recipient: VAULT_ETHEREUM_ADDRESS,
    amount: processAmount,
  });

  const rlpEncodedTx = ethers.Transaction.from(txRequest).unsignedSerialized;
  const requestId = generateRequestId(
    vaultAuthority,
    ethers.getBytes(rlpEncodedTx),
    SERVICE_CONFIG.ETHEREUM.SLIP44_COIN_TYPE,
    SERVICE_CONFIG.RETRY.DEFAULT_KEY_VERSION,
    path,
    SERVICE_CONFIG.CRYPTOGRAPHY.SIGNATURE_ALGORITHM,
    SERVICE_CONFIG.CRYPTOGRAPHY.TARGET_BLOCKCHAIN,
    '',
  );

  const requestIdBytes = Array.from(toBytes(requestId));
  const evmParams = evmParamsToProgram(txRequest);
  const amountBN = new BN(processAmount.toString());

  const result = await orchestrator.executeSignatureFlow(
    requestId,
    txRequest,
    async readEvent => {
      const [pendingDepositPda] = derivePendingDepositPda(requestIdBytes);
      try {
        const pendingDeposit =
          await bridgeContract.fetchPendingDeposit(pendingDepositPda);
        return await bridgeContract.claimErc20({
          requester: pendingDeposit.requester,
          requestIdBytes,
          serializedOutput: readEvent.serializedOutput,
          signature: readEvent.signature,
          erc20AddressBytes: pendingDeposit.erc20Address,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          msg.includes('Account does not exist') ||
          msg.includes('AccountNotFound')
        ) {
          return 'already-claimed';
        }
        throw e;
      }
    },
    async () => {
      return await bridgeContract.depositErc20({
        requester: userPublicKey,
        payer: relayerWallet.publicKey,
        requestIdBytes,
        erc20AddressBytes,
        recipientAddressBytes: Array.from(toBytes(VAULT_ETHEREUM_ADDRESS)),
        amount: amountBN,
        evmParams,
      });
    },
  );

  if (!result.success)
    return { ok: false, error: result.error ?? 'Deposit failed' };
  return {
    ok: true as const,
    requestId,
    initialSolanaTxHash: result.initialSolanaTxHash,
    ethereumTxHash: result.ethereumTxHash,
    claimTx: result.solanaResult,
  };
}

export async function handleWithdrawal(args: {
  requestId: string;
  erc20Address: string;
  transactionParams: EvmTransactionRequest;
}) {
  const { requestId, erc20Address, transactionParams } = args;
  const { orchestrator } = await initializeRelayerSetup({
    operationName: 'WITHDRAW',
    eventTimeoutMs: 60000,
  });

  const result = await orchestrator.executeSignatureFlow(
    requestId,
    transactionParams,
    async readEvent => {
      const bridgeContract = orchestrator.getBridgeContract();
      const requestIdBytes = Array.from(toBytes(requestId));
      const [pendingWithdrawalPda] = derivePendingWithdrawalPda(requestIdBytes);
      const pendingWithdrawal = (await bridgeContract.fetchPendingWithdrawal(
        pendingWithdrawalPda,
      )) as unknown as { requester: string };
      const erc20AddressBytes = Array.from(toBytes(erc20Address));

      return await bridgeContract.completeWithdrawErc20({
        requester: new PublicKey(pendingWithdrawal.requester),
        requestIdBytes,
        serializedOutput: readEvent.serializedOutput,
        signature: readEvent.signature,
        erc20AddressBytes,
      });
    },
  );

  if (!result.success)
    return { ok: false, error: result.error ?? 'Withdrawal failed' };
  return {
    ok: true as const,
    requestId,
    ethereumTxHash: result.ethereumTxHash,
    solanaTx: result.solanaResult,
  };
}

async function monitorTokenBalance(
  address: string,
  tokenAddress: string,
  provider: ethers.JsonRpcProvider,
): Promise<bigint | null> {
  const deadline = Date.now() + 60_000;
  const intervalMs = 5_000;
  const erc20Contract = new ethers.Contract(
    tokenAddress,
    ['function balanceOf(address owner) view returns (uint256)'],
    provider,
  );
  while (Date.now() < deadline) {
    try {
      const balance = await erc20Contract.balanceOf(address);
      if (balance > BigInt(0)) return balance;
    } catch {
      // swallow and retry
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return null;
}
