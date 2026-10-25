import { z } from 'zod';

const Origin = z.url().refine((s) => {
  const u = new URL(s);
  return u.protocol === 'https:' && /^[a-z0-9-]+\.onrender\.com$/.test(u.hostname) && !u.port && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/';
}, 'Use the HTTPS origin of the Render backend');
const paths = /^(?:\/health|\/dashboard|\/approvals|\/approval-actions|\/owner\/audit|\/owner\/payments\/[a-f0-9-]+\/return|\/api\/(?:limits|quotes|routes(?:\/[a-f0-9-]+)?|payments(?:\/[a-f0-9-]+)?))$/i;
const responseHeaders = ['content-type', 'www-authenticate', 'content-security-policy', 'referrer-policy', 'x-frame-options', 'x-content-type-options', 'allow'];
const unavailable = () => Response.json({ error: 'Payment backend unavailable; retry with the SAME idempotency key.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });

/** Stateless Vercel gateway. Wallet keys, SQLite and the worker stay on the persistent backend. */
export function createGateway(origin: string | undefined, fetcher: typeof fetch = fetch) {
  const config = Origin.safeParse(origin);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === '/' && ['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 302, headers: { Location: '/dashboard', 'Cache-Control': 'no-store' } });
    if (!paths.test(url.pathname)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, POST', 'Cache-Control': 'no-store' } });
    if (!config.success) return unavailable();
    const upstream = new URL(config.data);
    upstream.pathname = url.pathname; upstream.search = url.search;
    const headers = new Headers();
    for (const name of ['authorization', 'content-type', 'accept']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
    try {
      const body = request.method === 'POST' ? await request.arrayBuffer() : undefined;
      if (body && body.byteLength > 16384) return Response.json({ error: 'Request body exceeds 16 KiB' }, { status: 413 });
      const result = await fetcher(upstream, { method: request.method, headers, body, redirect: 'manual', signal: AbortSignal.any([request.signal, AbortSignal.timeout(20000)]) });
      const safe = new Headers({ 'Cache-Control': 'no-store' });
      for (const name of responseHeaders) { const value = result.headers.get(name); if (value) safe.set(name, value); }
      if (result.headers.has('location')) {
        const target = new URL(result.headers.get('location')!, upstream);
        if (target.origin !== upstream.origin) return unavailable();
        safe.set('location', target.pathname + target.search + target.hash);
      }
      return new Response(request.method === 'HEAD' ? null : result.body, { status: result.status, headers: safe });
    } catch { return unavailable(); }
  };
}
