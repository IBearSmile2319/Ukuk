import { OcrWord } from '../engine/engine.types';
import { buildAnchors, normalizeToken } from './template-builder';

const w = (text: string, x: number, y: number): OcrWord => ({
  text,
  confidence: 0.99,
  page: 1,
  bbox: { x, y, w: 0.1, h: 0.02 },
});

describe('buildAnchors', () => {
  it('normaliza tildes y puntuación', () => {
    expect(normalizeToken('Clínica:')).toBe('CLINICA');
    expect(normalizeToken('(R.U.C.)')).toBe('R.U.C');
  });

  it('conserva palabras presentes en ≥80% de las muestras en posición parecida', () => {
    const samples = [
      [w('RUC', 0.1, 0.1), w('TOTAL', 0.7, 0.8), w('Juan', 0.3, 0.3)],
      [w('RUC', 0.11, 0.1), w('TOTAL', 0.7, 0.81), w('Pedro', 0.3, 0.3)],
      [w('RUC', 0.1, 0.11), w('TOTAL', 0.69, 0.8), w('Ana', 0.3, 0.3)],
      [w('RUC', 0.1, 0.1), w('TOTAL', 0.2, 0.2)], // TOTAL en otra posición
      [w('RUC', 0.1, 0.1), w('TOTAL', 0.7, 0.8)],
    ];
    const anchors = buildAnchors(samples);
    expect(anchors.map((a) => a.text)).toEqual(['RUC', 'TOTAL']);
    expect(anchors[0].presence).toBe(1);
    expect(anchors[1].presence).toBe(0.8);
    expect(anchors[0].bbox.x).toBeCloseTo(0.102, 3);
    expect(anchors[1].bbox.y).toBeCloseTo(0.8025, 3);
  });

  it('descarta palabras por debajo del umbral', () => {
    const samples = [[w('RUC', 0.1, 0.1), w('SELLO', 0.5, 0.5)], [w('RUC', 0.1, 0.1)], [w('RUC', 0.1, 0.1)]];
    expect(buildAnchors(samples).map((a) => a.text)).toEqual(['RUC']);
    expect(buildAnchors(samples, { minPresence: 0.3 }).map((a) => a.text)).toEqual(['RUC', 'SELLO']);
  });

  it('con pocas muestras ignora montos y fechas, pero no RUC largos', () => {
    const anchors = buildAnchors([[w('118.00', 0.7, 0.8), w('15/03/2026', 0.5, 0.1), w('20100047218', 0.1, 0.1)]]);
    expect(anchors.map((a) => a.text)).toEqual(['20100047218']);
  });

  it('sin muestras no hay anclas', () => {
    expect(buildAnchors([])).toEqual([]);
  });
});
