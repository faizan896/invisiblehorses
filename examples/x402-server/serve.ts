import { serve } from '@hono/node-server';
import { createFixture, FIXTURE_PAY_TO } from './server.js';
import { AddressSchema } from '../../src/intent/schema.js';
import { configureProxy } from '../../src/network.js';

configureProxy();
const real = process.argv.includes('--real');
const payTo = real ? AddressSchema.parse(process.env.X402_PAY_TO) : FIXTURE_PAY_TO;
const fixture = createFixture(real, payTo);
serve({ fetch: fixture.app.fetch, hostname: '127.0.0.1', port: 4021 });
console.log(`http://127.0.0.1:4021/weather: ${real ? 'REAL Base Sepolia test USDC via x402.org/facilitator' : 'MOCK settlement; no chain calls'}`);
