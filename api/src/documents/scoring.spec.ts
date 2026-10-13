import { Finding } from '../engine/engine.types';
import { NO_TEMPLATE_NOTE, scoreDocument } from './scoring';

const f = (code: string, severity: Finding['severity'], confidence = 1) => ({ code, severity, confidence });

describe('scoreDocument', () => {
  it('sin hallazgos aprueba y avisa si no hay plantilla', () => {
    expect(scoreDocument([], { templateMatched: false })).toEqual({
      score: 0,
      verdict: 'aprobar',
      retake_required: false,
      confidence_note: NO_TEMPLATE_NOTE,
    });
    expect(scoreDocument([], { templateMatched: true }).confidence_note).toBeNull();
  });

  it('pondera severidad por confianza', () => {
    const r = scoreDocument([f('ela.region', 'high', 0.5), f('exif.software', 'low'), f('x.info', 'info')], {
      templateMatched: true,
    });
    expect(r.score).toBe(23); // 17.5 + 5 → 22.5 → 23
    expect(r.verdict).toBe('aprobar');
  });

  it('umbrales de revisar y rechazar, con tope en 100', () => {
    expect(scoreDocument([f('a.b', 'high'), f('c.d', 'low')], { templateMatched: true })).toMatchObject({
      score: 40,
      verdict: 'revisar',
    });
    expect(scoreDocument([f('a.b', 'high'), f('c.d', 'high')], { templateMatched: true })).toMatchObject({
      score: 70,
      verdict: 'rechazar',
    });
    expect(scoreDocument([f('a', 'critical'), f('b', 'critical')], { templateMatched: true }).score).toBe(100);
  });

  it('un hallazgo crítico obliga al menos a revisar', () => {
    const r = scoreDocument([f('mrz.check', 'critical', 0.3)], { templateMatched: true });
    expect(r.score).toBe(18);
    expect(r.verdict).toBe('revisar');
  });

  it('fallas de calidad piden otra foto', () => {
    const r = scoreDocument([f('image.blur', 'medium')], { templateMatched: true });
    expect(r).toMatchObject({ verdict: 'revisar', retake_required: true });
    expect(scoreDocument([f('image.blur', 'low')], { templateMatched: true }).retake_required).toBe(false);
    // Si lo demás ya alcanza para rechazar, se mantiene el rechazo.
    const bad = scoreDocument([f('image.glare', 'high'), f('reuse.same_file', 'high'), f('ela.x', 'high')], {
      templateMatched: true,
    });
    expect(bad).toMatchObject({ verdict: 'rechazar', retake_required: true });
  });
});
