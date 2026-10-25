import { z } from 'zod';
const secret = z.string().min(32).refine((v) => !/^(replace|change|example)/i.test(v), 'Replace the placeholder with an independent random secret');
const httpsUrl = z.url().refine((s) => { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; }, 'Expected an HTTPS URL without credentials, query or fragment');
export const ConfigSchema = z.object({
  BASE_SEPOLIA_RPC_URL: httpsUrl.default('https://sepolia.base.org'),
  RAILGATE_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  APPROVAL_SECRET: secret, OWNER_API_TOKEN: secret, AGENT_API_TOKEN: secret,
  AGENT_ID: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/).default('research-agent-07'),
  PUBLIC_BASE_URL: httpsUrl.refine((s) => { const u = new URL(s); return u.pathname === '/' && !u.hostname.endsWith('.example'); }, 'Set the real public HTTPS approval origin'),
  NTFY_SERVER: httpsUrl.refine((s) => new URL(s).pathname === '/').default('https://ntfy.sh'),
  NTFY_TOPIC: z.string().regex(/^[a-zA-Z0-9_-]{20,100}$/).refine((s) => !s.startsWith('replace_')),
  DEMO_RECIPIENT_ADDRESS: z.preprocess((v) => v === '' ? undefined : v, z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional()),
  DEMO_RECIPIENT_PRIVATE_KEY: z.preprocess((v) => v === '' ? undefined : v, z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional()),
  NTFY_TOKEN: z.string().optional(),
  HOST: z.string().default('127.0.0.1'), PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default('./data/railgate.sqlite'),
  RAILGATE_READ_ONLY: z.enum(['0','1']).default('0').transform((v) => v === '1'),
  POLICY_PATH: z.string().min(1).default('./policies/example.yaml'),
  COUNTERPARTY_PATH: z.string().min(1).default('./examples/counterparties.json'),
  WISE_SANDBOX_TOKEN: z.string().optional().transform((v) => v || undefined),
  WISE_SANDBOX_PROFILE_ID: z.preprocess((v) => v === '' ? undefined : v, z.string().regex(/^[1-9]\d{0,18}$/).optional()),
}).superRefine((v, ctx) => {
  if (new Set([v.APPROVAL_SECRET, v.OWNER_API_TOKEN, v.AGENT_API_TOKEN]).size !== 3) ctx.addIssue({ code: 'custom', message: 'Owner, agent and signing secrets must be different' });
  if (v.WISE_SANDBOX_TOKEN && !v.WISE_SANDBOX_PROFILE_ID) ctx.addIssue({ code: 'custom', path: ['WISE_SANDBOX_PROFILE_ID'], message: 'Required when a Wise sandbox token is configured' });
});
