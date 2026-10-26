import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { ExactProtocol, parseRequirements, unitsToCents } from '../src/x402/protocol.js';
import { TEST_USDC } from '../src/rails/usdc-base-sepolia.js';

const url = 'https://api.example.test/weather';
const requirement = { scheme: 'exact', network: 'eip155:84532' as const, asset: TEST_USDC, amount: '10000', payTo: '0x0000000000000000000000000000000000000001', maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } };
const paymentRequired = (): PaymentRequired => ({ x402Version: 2, resource: { url }, accepts: [requirement] });
const response = (body: PaymentRequired) => new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(body) } });
const signer = () => privateKeyToAccount(`0x${'0'.repeat(63)}1`);

describe('official x402 v2 exact Base Sepolia protocol', () => {
  it('parses official 402 headers and reconciles token atomic units without floats', () => {
    const result = parseRequirements(url, response(paymentRequired()));
    expect(result.selected.amount).toBe('10000');
    expect(unitsToCents('10000')).toBe(1);
    expect(unitsToCents('10001')).toBe(2);
    expect(unitsToCents('5000000')).toBe(500);
    for (const amount of ['-1', '1.1', '1e6', '00', '0']) expect(() => unitsToCents(amount)).toThrow();
  });
  it('refuses malformed challenges, another resource, mainnet, another asset, another scheme and unsafe domain/transfer metadata', () => {
    expect(() => parseRequirements(url, new Response(null, { status: 402 }))).toThrow();
    expect(() => parseRequirements(url, new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': 'broken' } }))).toThrow();
    expect(() => parseRequirements(url, response({ ...paymentRequired(), resource: { url: 'https://other.example.test/weather' } }))).toThrow();
    for (const bad of [{ network: 'eip155:8453' as const }, { scheme: 'upto' }, { asset: '0x0000000000000000000000000000000000000002' }, { amount: '0.01' }, { extra: { name: 'OTHER', version: '2' } }, { extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } }]) {
      expect(() => parseRequirements(url, response({ ...paymentRequired(), accepts: [{ ...requirement, ...bad }] }))).toThrow();
    }
  });
  it('constructs the authorization with the official client and official HTTP header encoding', async () => {
    let checks = 0;
    const protocol = new ExactProtocol({ signer: signer(), assertTestnet: async () => { checks++; }, verifySettlement: async () => true });
    const result = await protocol.create(parseRequirements(url, response(paymentRequired())));
    const decoded = decodePaymentSignatureHeader(result.header);
    expect(decoded).toEqual(result.payload);
    expect(decoded.accepted).toMatchObject({ network: 'eip155:84532', asset: TEST_USDC, amount: '10000' });
    expect(decoded.payload).toMatchObject({ signature: expect.stringMatching(/^0x/), authorization: { from: signer().address, to: requirement.payTo, value: '10000', nonce: expect.stringMatching(/^0x[0-9a-f]{64}$/i) } });
    expect(checks).toBeGreaterThan(0);
  });
  it('never signs if the actual RPC testnet guard fails', async () => {
    let signed = false;const account = signer();
    const protocol = new ExactProtocol({ signer: { address: account.address, signTypedData: async () => { signed = true; throw new Error('Must not sign'); } }, assertTestnet: async () => { throw new Error('Refusing mainnet'); }, verifySettlement: async () => true });
    await expect(protocol.create(parseRequirements(url, response(paymentRequired())))).rejects.toThrow(/mainnet/);
    expect(signed).toBe(false);
  });
});
