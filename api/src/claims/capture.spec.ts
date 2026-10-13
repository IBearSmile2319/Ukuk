import { capturePage } from './capture-page';
import { checkCapture } from './capture.service';
import { outsideCoverage } from './claims.service';

describe('captura en vivo', () => {
  const server = new Date('2026-10-13T15:00:00Z');
  const opts = { gpsMaxKm: 5, maxDriftMinutes: 10 };
  const declared = { lat: -12.1211, lng: -77.0297 }; // Miraflores

  it('foto en el lugar y con reloj correcto: sin hallazgos', () => {
    const r = checkCapture({ lat: -12.122, lng: -77.03, accuracy: 12, captured_at: '2026-10-13T14:59:30Z' }, declared, server, opts);
    expect(r.findings).toEqual([]);
    expect(r.capture).toMatchObject({ drift_seconds: 30, accuracy_m: 12 });
    expect(r.capture.distance_km).toBeLessThan(0.2);
  });

  it('GPS lejano, sin GPS y reloj desfasado', () => {
    const far = checkCapture({ lat: -12.0464, lng: -77.0428, captured_at: '2026-10-13T13:00:00Z' }, declared, server, opts);
    expect(far.findings.map((f) => f.code)).toEqual(['gps_lejano', 'reloj_desfasado']);
    expect(far.findings[0].evidence).toMatchObject({ distance_km: expect.any(Number) });
    expect(checkCapture({}, declared, server, opts).findings.map((f) => f.code)).toEqual(['sin_gps']);
    // Sin ubicación declarada (dirección en texto) no se puede comparar.
    expect(checkCapture({ lat: 0, lng: 0 }, null, server, opts).findings).toEqual([]);
  });

  it('la página usa la cámara sin galería ni dependencias externas', () => {
    const html = capturePage({ claimNumber: 'SIN-1', insurer: '<Seguros & Co>' });
    expect(html).toContain('getUserMedia');
    expect(html).not.toMatch(/type="file"|<script src=|https?:\/\//);
    expect(html).toContain('&#60;Seguros &#38; Co&#62;');
  });

  it('vigencia de la póliza', () => {
    const p = { policy_number: 'P', start_date: '2026-01-01', end_date: '2026-06-30', status: 'vigente' };
    expect(outsideCoverage(p, new Date('2026-03-01T12:00:00Z'))).toBe(false);
    expect(outsideCoverage(p, new Date('2026-07-01T12:00:00Z'))).toBe(true);
    expect(outsideCoverage({ ...p, status: 'anulada' }, null)).toBe(true);
    expect(outsideCoverage({}, null)).toBe(true);
  });
});
