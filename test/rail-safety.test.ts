import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { BaseSepoliaExecutor, TEST_USDC, assertChainId } from '../src/rails/usdc-base-sepolia.js';
import { ConfigSchema } from '../src/config.js';
import { intent } from './support.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function rpc(chainId: number) {
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += String(chunk);
    const body = JSON.parse(text) as { id: number; method: string };
    methods.push(body.method);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: `0x${chainId.toString(16)}` }));
  });
  server.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No RPC address');
  return { executor: new BaseSepoliaExecutor(`http://127.0.0.1:${address.port}`, generatePrivateKey()), methods };
}
async function signed(chainId = 84532, to: Hex = TEST_USDC, value = 0n) {
  // Ephemeral unfunded key generated for this local-only test; never saved or printed.
  const account = privateKeyToAccount(generatePrivateKey());
  return account.signTransaction({ chainId, type: 'eip1559', nonce: 0, gas: 100000n, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000n, to, value, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: ['0x0000000000000000000000000000000000000001', 1000000n] }) });
}
describe('test-money-only enforcement', () => {
  it('accepts ONLY Base Sepolia, including refusing other testnets', () => {
    expect(() => assertChainId(84532)).not.toThrow();
    for (const id of [1, 8453, 137, 11155111, 0]) expect(() => assertChainId(id)).toThrow(/Refusing/);
  });
  it('rejects a mainnet RPC at startup and before preparing or broadcasting', async () => {
    const { executor, methods } = await rpc(8453);
    await expect(executor.assertTestnet()).rejects.toThrow(/Refusing chain 8453/);
    await expect(executor.prepare(intent())).rejects.toThrow(/Refusing/);
    await expect(executor.broadcast(await signed())).rejects.toThrow(/Refusing/);
    expect(methods.every((m) => m === 'eth_chainId')).toBe(true);
  });
  it('refuses a mainnet-signed transaction even when the RPC claims testnet', async () => {
    const { executor, methods } = await rpc(84532);
    await expect(executor.broadcast(await signed(1))).rejects.toThrow(/Refusing chain 1/);
    expect(methods).not.toContain('eth_sendRawTransaction');
  });
  it('refuses a different token contract and native ETH transfers', async () => {
    const { executor, methods } = await rpc(84532);
    await expect(executor.broadcast(await signed(84532, '0x0000000000000000000000000000000000000002'))).rejects.toThrow(/fixed test USDC/);
    await expect(executor.broadcast(await signed(84532, TEST_USDC, 1n))).rejects.toThrow(/fixed test USDC/);
    expect(methods).not.toContain('eth_sendRawTransaction');
  });
  it('fails closed on missing configuration, insecure notification URLs and shared owner/agent secrets', () => {
    expect(ConfigSchema.safeParse({}).success).toBe(false);
    const good = { RAILGATE_PRIVATE_KEY: generatePrivateKey(), APPROVAL_SECRET: 'synthetic-signing-material-for-tests', OWNER_API_TOKEN: 'synthetic-owner-material-for-tests', AGENT_API_TOKEN: 'synthetic-agent-material-for-tests', PUBLIC_BASE_URL: 'https://owner.example.test', NTFY_TOPIC: 'synthetic-test-only-topic' };
    expect(ConfigSchema.safeParse(good).success).toBe(true);
    expect(ConfigSchema.safeParse({ ...good, AGENT_API_TOKEN: good.OWNER_API_TOKEN }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...good, PUBLIC_BASE_URL: 'http://owner.example.test' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...good, NTFY_SERVER: 'http://ntfy.sh' }).success).toBe(false);
  });
});
