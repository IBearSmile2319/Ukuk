import { computeRegime, docNumberError, nextReviewAt, plaftSettings } from './regime';

describe('régimen de debida diligencia', () => {
  const s = plaftSettings({});

  it('valores por defecto', () => {
    expect(s).toMatchObject({ threshold: 0.85, allowSimplified: false, reviewYears: { reforzado: 1, general: 2, simplificado: 3 } });
    expect(plaftSettings({ plaft_threshold: 0.9, plaft_review_years: { general: 1.5 } })).toMatchObject({
      threshold: 0.9,
      reviewYears: { general: 1.5, reforzado: 1 },
    });
    expect(plaftSettings({ plaft_threshold: 7 }).threshold).toBe(0.85);
  });

  it('reforzado ante PEP, sanción, país de alto riesgo o noticias negativas', () => {
    expect(computeRegime({ matches: [{ category: 'pep' }] }, s)).toEqual({ regime: 'reforzado', factors: ['coincidencia_pep'] });
    expect(computeRegime({ matches: [{ category: 'sanction' }] }, s).regime).toBe('reforzado');
    expect(computeRegime({ matches: [], nationality: 'ir' }, s)).toEqual({ regime: 'reforzado', factors: ['pais_alto_riesgo'] });
    expect(computeRegime({ matches: [], adverseMedia: true }, s).regime).toBe('reforzado');
  });

  it('las coincidencias descartadas no cuentan; lista de interés no obliga a reforzado', () => {
    expect(computeRegime({ matches: [{ category: 'sanction', status: 'descartada' }] }, s)).toEqual({ regime: 'general', factors: [] });
    expect(computeRegime({ matches: [{ category: 'interest' }] }, s).regime).toBe('general');
  });

  it('simplificado solo si el cliente lo permite y no hay factores', () => {
    const allow = plaftSettings({ plaft_allow_simplified: true });
    expect(computeRegime({ matches: [], nationality: 'PE' }, allow).regime).toBe('simplificado');
    expect(computeRegime({ matches: [{ category: 'interest' }] }, allow).regime).toBe('general');
    expect(computeRegime({ matches: [] }, s).regime).toBe('general');
  });

  it('próxima revisión según régimen y tope de 2 años para proveedores', () => {
    const from = new Date('2026-04-15T10:00:00Z');
    expect(nextReviewAt(from, 'cliente', 'reforzado', s).toISOString()).toBe('2027-04-15T10:00:00.000Z');
    expect(nextReviewAt(from, 'cliente', 'general', s).toISOString()).toBe('2028-04-15T10:00:00.000Z');
    expect(nextReviewAt(from, 'trabajador', 'simplificado', s).toISOString()).toBe('2029-04-15T10:00:00.000Z');
    expect(nextReviewAt(from, 'proveedor', 'simplificado', s).toISOString()).toBe('2028-04-15T10:00:00.000Z');
    expect(nextReviewAt(from, 'proveedor', 'reforzado', s).toISOString()).toBe('2027-04-15T10:00:00.000Z');
  });

  it('valida el formato del documento', () => {
    expect(docNumberError('individual', 'DNI', '12345678')).toBeNull();
    expect(docNumberError('individual', 'DNI', '1234567')).toMatch(/8 dígitos/);
    expect(docNumberError('entity', 'RUC', '20100047218')).toBeNull();
    expect(docNumberError('entity', 'DNI', '12345678')).toMatch(/jurídica/);
    expect(docNumberError('individual', 'CE', '001234567')).toBeNull();
  });
});
