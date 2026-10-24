import {
  createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http,
  keccak256, parseTransaction, TransactionReceiptNotFoundError, type Hex,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { minor, type PaymentIntent } from '../intent/schema.js';
import type { TestnetExecutor, SignedTransfer } from './testnet.js';

// Circle's Base Sepolia TEST USDC; deliberately not configurable to another chain/token.
// https://developers.circle.com/stablecoins/usdc-contract-addresses
export const TEST_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
export const TEST_CHAIN_ID = 84532;
export function assertChainId(chainId: number) {
  if (chainId !== TEST_CHAIN_ID) throw new Error(`Refusing chain ${chainId}; only Base Sepolia (84532) is permitted`);
}
export class BaseSepoliaExecutor implements TestnetExecutor {
  private readonly account;
  private readonly publicClient;
  private readonly wallet;
  constructor(rpcUrl: string, privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
    // Disable RPC mutation retries; durable identical-byte replay is controlled by the service.
    this.publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl, { retryCount: 0, timeout: 15_000 }) });
    this.wallet = createWalletClient({ account: this.account, chain: baseSepolia, transport: http(rpcUrl, { retryCount: 0, timeout: 15_000 }) });
  }
  async assertTestnet() { assertChainId(await this.publicClient.getChainId()); }
  async verifyToken() {
    await this.assertTestnet();
    const [symbol, decimals, code] = await Promise.all([
      this.publicClient.readContract({ address: TEST_USDC, abi: erc20Abi, functionName: 'symbol' }),
      this.publicClient.readContract({ address: TEST_USDC, abi: erc20Abi, functionName: 'decimals' }),
      this.publicClient.getCode({ address: TEST_USDC }),
    ]);
    if (symbol !== 'USDC' || decimals !== 6 || !code || code === '0x') throw new Error('Expected Base Sepolia USDC contract is unavailable');
  }
  async prepare(intent: PaymentIntent): Promise<SignedTransfer> {
    await this.assertTestnet();
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [intent.recipient.address, BigInt(minor(intent.amount)) * 10_000n] });
    // Estimate execution before signing; no native ETH value is ever transferred.
    const request = await this.wallet.prepareTransactionRequest({ account: this.account, chain: baseSepolia, type: 'eip1559', to: TEST_USDC, data, value: 0n });
    assertChainId(request.chainId);
    const raw = await this.account.signTransaction(request);
    return { raw, hash: keccak256(raw) };
  }
  async broadcast(raw: Hex) {
    await this.assertTestnet();
    const tx = parseTransaction(raw);
    assertChainId(tx.chainId ?? 0);
    if (tx.to?.toLowerCase() !== TEST_USDC.toLowerCase() || (tx.value ?? 0n) !== 0n) throw new Error('Refusing a transaction outside the fixed test USDC rail');
    return this.wallet.sendRawTransaction({ serializedTransaction: raw });
  }
  async receipt(hash: Hex) {
    await this.assertTestnet();
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash });
      const head = await this.publicClient.getBlockNumber();
      if (head < receipt.blockNumber + 1n) return 'pending' as const; // Two L2 confirmations.
      return receipt.status === 'success' ? 'success' as const : 'reverted' as const;
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return 'pending' as const;
      throw error;
    }
  }
}
