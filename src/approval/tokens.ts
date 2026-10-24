import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.js';

const Payload = z.strictObject({
  v: z.literal(1), payment_id: z.uuid(), action: z.enum(['approve', 'reject']),
  nonce: z.string().regex(/^[a-f0-9]{32}$/), expires_at: z.iso.datetime(),
});
export type ApprovalPayload = z.infer<typeof Payload>;
export class ApprovalTokens {
  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error('APPROVAL_SECRET must have at least 32 characters');
  }
  sign(payload: ApprovalPayload) {
    const body = Buffer.from(JSON.stringify(Payload.parse(payload))).toString('base64url');
    return `${body}.${this.mac(body).toString('base64url')}`;
  }
  verify(token: string, now: string): ApprovalPayload {
    if (token.length > 1500 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new AppError(403, 'Invalid approval token');
    const [body, signature] = token.split('.') as [string, string];
    const expected = this.mac(body);
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AppError(403, 'Invalid approval signature');
    let payload: ApprovalPayload;
    try { payload = Payload.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))); }
    catch { throw new AppError(403, 'Invalid approval payload'); }
    if (Date.parse(now) >= Date.parse(payload.expires_at)) throw new AppError(410, 'Approval token expired');
    return payload;
  }
  private mac(body: string) { return createHmac('sha256', this.secret).update(body).digest(); }
}
