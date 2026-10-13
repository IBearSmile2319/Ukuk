import { MAX_CAPTURE_TTL_SECONDS, signCaptureToken, verifyCaptureToken } from './capture-token';
import { haversineKm, isValidLatLng } from './geo';
import { assessRisk } from './risk';
import { metaSignature, verifyMetaSignature } from './webhook-signature';

describe('token de captura', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');

  it('firma y verifica', () => {
    const { token, expiresAt } = signCaptureToken('s', 'claim-1', 'tenant-1', 3600, now);
    expect(expiresAt.toISOString()).toBe('2026-10-13T13:00:00.000Z');
    expect(verifyCaptureToken('s', token, now)).toEqual({ ok: true, payload: { claimId: 'claim-1', tenantId: 'tenant-1', exp: now / 1000 + 3600 } });
  });

  it('rechaza firma alterada, otro secreto y basura', () => {
    const { token } = signCaptureToken('s', 'c', 't', 3600, now);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ c: 'otro', t: 't', exp: now / 1000 + 3600 })).toString('base64url');
    expect(verifyCaptureToken('s', `${forged}.${sig}`, now)).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyCaptureToken('otro', token, now).ok).toBe(false);
    expect(verifyCaptureToken('s', `${body}`, now).ok).toBe(false);
    expect(verifyCaptureToken('s', 'a.b.c', now).ok).toBe(false);
  });

  it('expira y nunca dura más de 24 h', () => {
    const { token } = signCaptureToken('s', 'c', 't', 7 * 86400, now);
    expect(verifyCaptureToken('s', token, now + (MAX_CAPTURE_TTL_SECONDS - 1) * 1000).ok).toBe(true);
    expect(verifyCaptureToken('s', token, now + MAX_CAPTURE_TTL_SECONDS * 1000)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('haversine', () => {
  it('Lima (Plaza de Armas) → Miraflores ≈ 8.6 km', () => {
    const d = haversineKm({ lat: -12.0464, lng: -77.0428 }, { lat: -12.1211, lng: -77.0297 });
    expect(d).toBeGreaterThan(8.2);
    expect(d).toBeLessThan(8.6);
  });

  it('mismo punto = 0 y Lima → Cusco ≈ 570 km', () => {
    expect(haversineKm({ lat: 1, lng: 1 }, { lat: 1, lng: 1 })).toBe(0);
    const cusco = haversineKm({ lat: -12.0464, lng: -77.0428 }, { lat: -13.5319, lng: -71.9675 });
    expect(cusco).toBeGreaterThan(560);
    expect(cusco).toBeLessThan(580);
  });

  it('valida coordenadas', () => {
    expect(isValidLatLng({ lat: -12, lng: -77 })).toBe(true);
    expect(isValidLatLng({ lat: 91, lng: 0 })).toBe(false);
    expect(isValidLatLng({ lat: NaN, lng: 0 })).toBe(false);
  });
});

describe('firma del webhook de Meta', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');

  it('acepta la firma correcta y rechaza las demás', () => {
    expect(verifyMetaSignature('secret', body, metaSignature('secret', body))).toBe(true);
    expect(verifyMetaSignature('secret', body, metaSignature('otro', body))).toBe(false);
    expect(verifyMetaSignature('secret', Buffer.from(body.toString() + ' '), metaSignature('secret', body))).toBe(false);
    expect(verifyMetaSignature('secret', body, 'sha256=zz')).toBe(false);
    expect(verifyMetaSignature('secret', body, undefined)).toBe(false);
    // Sin secreto configurado se rechaza todo.
    expect(verifyMetaSignature(undefined, body, metaSignature('secret', body))).toBe(false);
  });
});

describe('riesgo', () => {
  const f = (code: string, severity: any, layer: any = 'forensics') => ({ code, severity, layer, confidence: 1, message: code });

  it('caso limpio es bajo', () => {
    expect(assessRisk({ findings: [f('x', 'low')], lateNotice: false })).toMatchObject({ level: 'bajo', requiresAnalystReview: false });
  });

  it('alto ante hallazgo crítico, reuso, GPS lejano o aviso tardío', () => {
    expect(assessRisk({ findings: [f('ela', 'critical')], lateNotice: false }).requiresAnalystReview).toBe(true);
    expect(assessRisk({ findings: [f('dup', 'medium', 'reuse')], lateNotice: false }).level).toBe('alto');
    expect(assessRisk({ findings: [f('gps_lejano', 'medium')], lateNotice: false }).level).toBe('alto');
    const late = assessRisk({ findings: [], lateNotice: true });
    expect(late).toMatchObject({ level: 'alto', requiresAnalystReview: true });
    expect(late.reasons[0]).toMatch(/aviso_tardio/);
  });

  it('medio por acumulación', () => {
    expect(assessRisk({ findings: [f('a', 'medium'), f('b', 'medium')], lateNotice: false }).level).toBe('medio');
  });
});
