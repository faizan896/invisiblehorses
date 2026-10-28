import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGateway } from '../src/http/gateway.js';
import { createConsoleGateway } from '../src/console/gateway.js';

/** Vercel Node function. Accept both Vercel-parsed and raw Node request bodies. */
export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  try {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400); res.end('Invalid request path'); return; }
    const method = req.method ?? 'GET';
    let body: Buffer | undefined;
    if (method === 'POST') {
      if (req.body !== undefined) body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      else {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { const data = Buffer.from(chunk); bytes += data.length; if (bytes > 16384) { res.writeHead(413); res.end('Request body exceeds 16 KiB'); return; } chunks.push(data); }
        body = Buffer.concat(chunks);
      }
      if (body.length > 16384) { res.writeHead(413); res.end('Request body exceeds 16 KiB'); return; }
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    const request = new Request(new URL(req.url, 'https://railgate-gateway.invalid'), { method, headers, body: body ? new Uint8Array(body) : undefined });
    const response = await (new URL(request.url).pathname.startsWith('/console-api/') ? createConsoleGateway() : createGateway(process.env.RAILGATE_BACKEND_ORIGIN))(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res); else res.end();
  } catch {
    if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Gateway unavailable; retry with the SAME idempotency key.' }));
  }
}
