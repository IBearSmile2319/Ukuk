import { createHmac, timingSafeEqual } from 'node:crypto';

/** Firma de Meta: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, cuerpo exacto). */
export function verifyMetaSignature(appSecret: string | undefined, rawBody: Buffer | undefined, header: unknown): boolean {
  if (!appSecret || !rawBody || typeof header !== 'string') return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const got = Buffer.from(m[1], 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function metaSignature(appSecret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/** Firma de lo que enviamos al sistema de siniestros del cliente. */
export function ukukSignature(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
