import { createHmac, timingSafeEqual } from 'node:crypto';

/** Enlace de captura en vivo: {claim, tenant, exp} firmado con HMAC-SHA256 (linkSecret). */

export interface CapturePayload {
  claimId: string;
  tenantId: string;
  /** Segundos Unix. */
  exp: number;
}

export const MAX_CAPTURE_TTL_SECONDS = 24 * 3600;

const sign = (secret: string, body: string) => createHmac('sha256', secret).update(`capture.${body}`).digest('base64url');

export function signCaptureToken(
  secret: string,
  claimId: string,
  tenantId: string,
  ttlSeconds = MAX_CAPTURE_TTL_SECONDS,
  now = Date.now(),
): { token: string; expiresAt: Date } {
  const ttl = Math.min(Math.max(ttlSeconds, 60), MAX_CAPTURE_TTL_SECONDS);
  const exp = Math.floor(now / 1000) + ttl;
  const body = Buffer.from(JSON.stringify({ c: claimId, t: tenantId, exp })).toString('base64url');
  return { token: `${body}.${sign(secret, body)}`, expiresAt: new Date(exp * 1000) };
}

export type VerifyResult = { ok: true; payload: CapturePayload } | { ok: false; reason: 'invalid' | 'expired' };

export function verifyCaptureToken(secret: string, token: string, now = Date.now()): VerifyResult {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return { ok: false, reason: 'invalid' };
  const expected = Buffer.from(sign(secret, body));
  const got = Buffer.from(sig);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, reason: 'invalid' };
  let parsed: { c?: unknown; t?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof parsed.c !== 'string' || typeof parsed.t !== 'string' || typeof parsed.exp !== 'number') {
    return { ok: false, reason: 'invalid' };
  }
  if (parsed.exp * 1000 <= now) return { ok: false, reason: 'expired' };
  return { ok: true, payload: { claimId: parsed.c, tenantId: parsed.t, exp: parsed.exp } };
}
