import { createPublicClient, decodeFunctionData, erc20Abi, http, parseEventLogs, type Hex } from 'viem';
import { eip3009ABI, type ExactEIP3009Payload } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { ExactProtocol } from './protocol.js';
import { assertChainId, TEST_USDC } from '../rails/usdc-base-sepolia.js';

/** Actual chain ID, fixed contract metadata and exact transfer logs, never a merchant claim alone. */
export function realX402Protocol(rpcUrl: string, privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl, { retryCount: 0, timeout: 15000 }) });
  const assertTestnet = async () => {
    assertChainId(await client.getChainId());
    const [decimals, symbol, code] = await Promise.all([
      client.readContract({ address: TEST_USDC, abi: erc20Abi, functionName: 'decimals' }),
      client.readContract({ address: TEST_USDC, abi: erc20Abi, functionName: 'symbol' }), client.getCode({ address: TEST_USDC }),
    ]);
    if (decimals !== 6 || symbol !== 'USDC' || !code || code === '0x') throw new Error('Fixed Base Sepolia test USDC contract unavailable');
  };
  return new ExactProtocol({ signer: account, assertTestnet, verifySettlement: async (receipt, q, payload) => {
    if (!payload) return false;
    const tx = await client.getTransactionReceipt({ hash: receipt.transaction as Hex });
    if (tx.status !== 'success' || await client.getBlockNumber() < tx.blockNumber + 1n) return false;
    // Bind this receipt to this authorization nonce, not an unrelated old transfer.
    const transaction = await client.getTransaction({ hash: receipt.transaction as Hex });
    if (transaction.to?.toLowerCase() !== TEST_USDC.toLowerCase()) return false;
    const call = decodeFunctionData({ abi: eip3009ABI, data: transaction.input });
    const a = (payload.payload as ExactEIP3009Payload).authorization;
    if (call.functionName !== 'transferWithAuthorization' || !call.args || String(call.args[0]).toLowerCase() !== account.address.toLowerCase() || String(call.args[1]).toLowerCase() !== q.payTo.toLowerCase() || String(call.args[2]) !== q.amount || String(call.args[3]) !== a.validAfter || String(call.args[4]) !== a.validBefore || call.args[5] !== a.nonce) return false;
    return parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: tx.logs }).some(l => l.address.toLowerCase() === TEST_USDC.toLowerCase() && l.args.from.toLowerCase() === account.address.toLowerCase() && l.args.to.toLowerCase() === q.payTo.toLowerCase() && l.args.value === BigInt(q.amount));
  } });
}
