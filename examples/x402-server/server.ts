import { Hono } from 'hono';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { authorizationTypes, type ExactEIP3009Payload } from '@x402/evm';
import { keccak256, stringToHex, verifyTypedData } from 'viem';
import { TEST_USDC } from '../../src/rails/usdc-base-sepolia.js';
import { X402_NETWORK } from '../../src/x402/protocol.js';

export const FIXTURE_PAY_TO = '0x0000000000000000000000000000000000000002';
/** Official x402 middleware; only the chain/facilitator is simulated in default mode. */
export function createFixture(real = false, payTo: `0x${string}` = FIXTURE_PAY_TO) {
  const receipts = new Map<string, { receipt: SettleResponse; requirement: PaymentRequirements }>();
  const nonces = new Set<string>(), cache = new Map<string, Response>();
  const mock: FacilitatorClient = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: X402_NETWORK }], extensions: [], signers: { [X402_NETWORK]: [payTo] } }),
    verify: async (p: PaymentPayload, q: PaymentRequirements) => {
      const { authorization: a, signature } = p.payload as ExactEIP3009Payload;
      if (!signature) return { isValid: false, invalidReason: 'missing_signature' };
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (p.x402Version !== 2 || p.accepted.network !== X402_NETWORK || q.network !== X402_NETWORK || q.asset.toLowerCase() !== TEST_USDC.toLowerCase() || q.scheme !== 'exact' || a.to.toLowerCase() !== q.payTo.toLowerCase() || a.value !== q.amount || BigInt(a.validBefore) <= now || BigInt(a.validAfter) > now || nonces.has(`${a.from}:${a.nonce}`)) return { isValid: false, invalidReason: 'mock_authorization_rejected' };
      const valid = await verifyTypedData({ address: a.from, domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: TEST_USDC }, types: authorizationTypes, primaryType: 'TransferWithAuthorization', message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) }, signature });
      return { isValid: valid, payer: a.from, ...(valid ? {} : { invalidReason: 'invalid_signature' }) };
    },
    settle: async (p, q) => {
      if (!(await mock.verify(p, q)).isValid) return { success: false, network: X402_NETWORK, transaction: '', errorReason: 'mock_authorization_rejected' };
      const a = (p.payload as ExactEIP3009Payload).authorization;
      if (nonces.has(`${a.from}:${a.nonce}`)) return { success: false, network: X402_NETWORK, transaction: '', errorReason: 'mock_nonce_already_used' };
      nonces.add(`${a.from}:${a.nonce}`);
      const transaction = keccak256(stringToHex(`MOCK:${a.from}:${a.nonce}`));
      const receipt = { success: true, transaction, network: X402_NETWORK, payer: a.from, amount: q.amount };
      receipts.set(transaction, { receipt, requirement: q }); return receipt;
    },
  };
  const server = new x402ResourceServer(real ? new HTTPFacilitatorClient({ url: 'https://x402.org/facilitator' }) : mock).register(X402_NETWORK, new ExactEvmScheme());
  const app = new Hono();
  // Simulates a merchant with a durable response cache. Production merchants need their own
  // durable idempotency/response storage; this process-local fixture is deliberately disposable.
  app.use('*', async (c, next) => {
    const header = c.req.header('PAYMENT-SIGNATURE'), key = `${c.req.url}:${header}`;
    if (header && cache.has(key)) return cache.get(key)!.clone();
    await next();
    if (header && c.res.ok && c.res.headers.has('PAYMENT-RESPONSE')) cache.set(key, c.res.clone());
  });
  app.use(paymentMiddleware({
    'GET /weather': { accepts: { scheme: 'exact', network: X402_NETWORK, price: '$0.01', payTo }, description: 'Test weather', mimeType: 'application/json' },
    'GET /expensive': { accepts: { scheme: 'exact', network: X402_NETWORK, price: '$5.00', payTo }, description: 'Over-limit test dataset', mimeType: 'application/json' },
  }, server));
  app.get('/weather', c => c.json({ weather: 'sunny', settlement: real ? 'Base Sepolia TEST USDC' : 'MOCK — no chain transaction' }));
  app.get('/expensive', c => c.json({ dataset: 'test data', settlement: real ? 'Base Sepolia TEST USDC' : 'MOCK — no chain transaction' }));
  return { app, charges: () => receipts.size, verifyReceipt: (r: SettleResponse, q: PaymentRequirements) => {
    const saved = receipts.get(r.transaction);
    return !!saved && saved.receipt.payer?.toLowerCase() === r.payer?.toLowerCase() && saved.requirement.payTo.toLowerCase() === q.payTo.toLowerCase() && saved.requirement.amount === q.amount;
  } };
}
