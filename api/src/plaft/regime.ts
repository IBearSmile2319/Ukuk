export const RELATIONS = ['cliente', 'proveedor', 'trabajador', 'director', 'accionista'] as const;
export type Relation = (typeof RELATIONS)[number];
export const KINDS = ['individual', 'entity'] as const;
export type Kind = (typeof KINDS)[number];
export const DOC_TYPES = ['DNI', 'CE', 'RUC', 'PASAPORTE'] as const;
export type DocType = (typeof DOC_TYPES)[number];
export type Regime = 'simplificado' | 'general' | 'reforzado';

/**
 * Jurisdicciones de alto riesgo del GAFI ("llamado a la acción"). Se revisa tras cada
 * plenaria (feb/jun/oct); cada cliente puede reemplazarla en settings.plaft_high_risk_countries.
 */
export const HIGH_RISK_COUNTRIES = ['KP', 'PRK', 'IR', 'IRN', 'MM', 'MMR'];

/** Años entre revisiones de debida diligencia por régimen. */
export const DEFAULT_REVIEW_YEARS: Record<Regime, number> = { reforzado: 1, general: 2, simplificado: 3 };

/** Res. SBS 01015-2026: la debida diligencia de proveedores se actualiza al menos cada 2 años. */
export const PROVIDER_MAX_YEARS = 2;

export const DEFAULT_THRESHOLD = 0.85;

export interface PlaftSettings {
  threshold: number;
  allowSimplified: boolean;
  highRiskCountries: string[];
  reviewYears: Record<Regime, number>;
}

/** Lee la configuración PLAFT de tenant.settings con valores por defecto seguros. */
export function plaftSettings(settings: Record<string, unknown>): PlaftSettings {
  const t = Number(settings.plaft_threshold);
  const years = (settings.plaft_review_years ?? {}) as Partial<Record<Regime, unknown>>;
  const y = (r: Regime) => {
    const v = Number(years[r]);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_REVIEW_YEARS[r];
  };
  const countries = settings.plaft_high_risk_countries;
  return {
    threshold: Number.isFinite(t) && t > 0 && t <= 1 ? t : DEFAULT_THRESHOLD,
    allowSimplified: settings.plaft_allow_simplified === true,
    highRiskCountries: Array.isArray(countries) ? countries.map((c) => String(c).toUpperCase()) : HIGH_RISK_COUNTRIES,
    reviewYears: { reforzado: y('reforzado'), general: y('general'), simplificado: y('simplificado') },
  };
}

export interface RegimeInput {
  /** Coincidencias vigentes (las descartadas como falso positivo no cuentan). */
  matches: { category: string; status?: string }[];
  nationality?: string | null;
  adverseMedia?: boolean;
}

/**
 * Régimen de debida diligencia (Res. SBS 789-2018): reforzado ante PEP, sanciones,
 * país de alto riesgo o noticias negativas; simplificado solo si el cliente lo permite
 * y no hay ningún factor de riesgo; general en los demás casos.
 */
export function computeRegime(input: RegimeInput, s: PlaftSettings): { regime: Regime; factors: string[] } {
  const active = input.matches.filter((m) => m.status !== 'descartada');
  const factors: string[] = [];
  if (active.some((m) => m.category === 'pep')) factors.push('coincidencia_pep');
  if (active.some((m) => m.category === 'sanction')) factors.push('coincidencia_sancion');
  if (active.some((m) => m.category === 'interest')) factors.push('coincidencia_lista_interes');
  const nat = input.nationality?.trim().toUpperCase();
  if (nat && s.highRiskCountries.includes(nat)) factors.push('pais_alto_riesgo');
  if (input.adverseMedia) factors.push('noticias_negativas');

  const enhanced = factors.some((f) => f !== 'coincidencia_lista_interes');
  if (enhanced) return { regime: 'reforzado', factors };
  if (s.allowSimplified && factors.length === 0) return { regime: 'simplificado', factors };
  return { regime: 'general', factors };
}

/** Próxima revisión: según el régimen y, para proveedores, nunca más de 2 años. */
export function nextReviewAt(from: Date, relation: Relation, regime: Regime, s: PlaftSettings): Date {
  let years = s.reviewYears[regime];
  if (relation === 'proveedor') years = Math.min(years, PROVIDER_MAX_YEARS);
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + Math.round(years * 12));
  return d;
}

/** Validación de formato del documento; el RUC se valida además con el motor. */
export function docNumberError(kind: Kind, docType: DocType, docNumber: string): string | null {
  if (kind === 'entity' && (docType === 'DNI' || docType === 'CE')) {
    return 'Una persona jurídica se identifica con RUC (o pasaporte/registro extranjero)';
  }
  switch (docType) {
    case 'DNI':
      return /^\d{8}$/.test(docNumber) ? null : 'El DNI debe tener 8 dígitos';
    case 'RUC':
      return /^\d{11}$/.test(docNumber) ? null : 'El RUC debe tener 11 dígitos';
    case 'CE':
      return /^[A-Z0-9]{6,12}$/.test(docNumber) ? null : 'El carné de extranjería debe tener entre 6 y 12 caracteres alfanuméricos';
    case 'PASAPORTE':
      return /^[A-Z0-9]{5,15}$/.test(docNumber) ? null : 'El pasaporte debe tener entre 5 y 15 caracteres alfanuméricos';
  }
}
