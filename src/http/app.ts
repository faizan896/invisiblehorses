import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import type { PaymentService } from '../executor/service.js';
import { AppError } from '../errors.js';
import type { QuoteService } from '../rails/quotes.js';
import type { RoutingService } from '../router/service.js';

export type HttpConfig = { ownerToken: string; agentToken: string; agentId: string };
const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const escape = (s: unknown) => String(s).replace(/[&<>"']/g, (v) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[v]!);
const page = (title: string, content: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)} · railgate</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#18222c}nav,a{color:#1646a0}article{border:1px solid #cbd5e1;border-radius:8px;padding:20px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{padding:10px 20px;margin:8px}form{display:inline}td,th{padding:10px;text-align:left;vertical-align:top}table{width:100%;border-collapse:collapse}tr{border-bottom:1px solid #ddd}</style><body><h1>railgate <small>TEST MONEY ONLY</small></h1><nav><a href="/approvals">Approvals</a> · <a href="/dashboard">Dashboard</a></nav><h2>${escape(title)}</h2>${content}</body></html>`;

export function createApp(service: PaymentService, config: HttpConfig, quotes?: QuoteService, routing?: RoutingService) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Request body exceeds 16 KiB' }, 413) }));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff'); c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid input', issues: error instanceof ZodError ? error.issues.map((i) => ({ path: i.path, message: i.message })) : [] }, 400);
    return c.json({ error: 'Operation unavailable; no replacement payment was created' }, 503);
  });
  const owner = (header: string | undefined) => {
    let candidate = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (header?.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      if (decoded.startsWith('owner:')) candidate = decoded.slice(6);
    }
    return !!candidate && same(candidate, config.ownerToken);
  };
  app.get('/health', (c) => c.json({ status: 'ok', network: 'Base Sepolia', chain_id: 84532, test_money_only: true }));
  app.use('/api/*', async (c, next) => {
    const token = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
    if (!same(token, config.agentToken)) throw new AppError(401, 'Agent authentication required');
    await next();
  });
  app.post('/api/payments', async (c) => {
    try { return c.json(await service.request(await c.req.json(), config.agentId), 202); }
    catch (error) {
      if (!(error instanceof AppError && error.status === 409)) service.store.audit(null, 'request_rejected', config.agentId, { reason: 'Invalid or unauthorized payment request' }, new Date().toISOString());
      throw error;
    }
  });
  app.get('/api/payments', (c) => {
    const query = z.strictObject({ limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(c.req.query());
    return c.json(service.list(config.agentId, query.limit));
  });
  app.get('/api/payments/:id', (c) => c.json(service.get(z.uuid().parse(c.req.param('id')), config.agentId)));
  app.get('/api/limits', (c) => c.json(service.limits()));
  app.post('/api/quotes', async (c) => {
    if (!quotes) throw new AppError(503, 'Quote service unavailable');
    const result = await quotes.quotes(await c.req.json(), config.agentId);
    service.store.audit(null, 'quotes_requested', config.agentId, { intent: result.intent, quotes: result.quotes.map((q) => ({ id: q.id, rail: q.rail, total_all_in_cost: q.total_all_in_cost, pricing: q.pricing })), unavailable: result.unavailable }, new Date().toISOString());
    return c.json(result);
  });
  app.post('/api/routes', async (c) => {
    if (!routing) throw new AppError(503, 'Route planner unavailable');
    return c.json(await routing.plan(await c.req.json(), config.agentId));
  });
  app.get('/api/routes/:id', (c) => {
    if (!routing) throw new AppError(503, 'Route planner unavailable');
    return c.json(routing.get(c.req.param('id'), config.agentId));
  });
  for (const path of ['/approvals', '/dashboard', '/owner/*']) app.use(path, async (c, next) => {
    if (!owner(c.req.header('Authorization'))) {
      c.header('WWW-Authenticate', 'Basic realm="railgate owner", charset="UTF-8"');
      return c.text('Owner authentication required', 401);
    }
    await next();
  });
  app.get('/approvals', (c) => {
    const entries = service.pending();
    return c.html(page('Pending approvals', entries.length ? entries.map(({ payment: p, notification: n }) => `<article><h3>${escape(p.intent.payer)} → ${escape(p.intent.recipient.name)}: $${escape(p.intent.amount)} test USDC</h3><p>${escape(p.intent.purpose)}</p><p>Recipient: ${escape(p.intent.recipient.address)}</p><p>Reasons: ${escape(p.evaluation.reasons.join('; '))}</p><p>Expires: ${escape(n.expiresAt)}</p>${(['Approve', 'Reject'] as const).map((action) => `<form method="post" action="${escape(action === 'Approve' ? n.approveUrl : n.rejectUrl)}"><button>${action}</button></form>`).join('')}</article>`).join('') : '<p>No pending approvals.</p>'));
  });
  app.post('/approval-actions', (c) => {
    const query = z.strictObject({ token: z.string().min(1).max(1500) }).parse(c.req.query());
    const result = service.decide(query.token);
    return c.html(page('Approval recorded', `<p>Payment ${escape(result.id)}: ${escape(result.status)}</p><p>${escape(result.evaluation.reasons.join('; '))}</p>`));
  });
  // GET never changes state: link scanners cannot approve/reject a payment.
  app.get('/approval-actions', (c) => c.text('Approval actions require POST', 405));
  app.get('/dashboard', (c) => c.html(page('Recent payments and audit log', `<table><thead><tr><th>When</th><th>Intent</th><th>Decision / status</th></tr></thead><tbody>${service.list().map((p) => `<tr><td>${escape(p.created_at)}</td><td>${escape(p.intent.payer)} → ${escape(p.intent.recipient.name)}<br>$${escape(p.intent.amount)} test USDC<br>${escape(p.intent.purpose)}</td><td>${escape(p.status)}<br>${escape(p.evaluation.reasons.join('; '))}<br>${escape(p.transaction_hash ?? '')}</td></tr>`).join('')}</tbody></table><h2>Append-only audit log</h2><pre>${escape(JSON.stringify(service.store.events(), null, 2))}</pre>`)));
  app.get('/owner/audit', (c) => c.json(service.store.events()));
  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  return app;
}
