import { Finding, Severity } from '../engine/engine.types';

export type Verdict = 'aprobar' | 'revisar' | 'rechazar';

/** Puntos de riesgo por severidad; se multiplican por la confianza del hallazgo. */
export const SEVERITY_WEIGHTS: Record<Severity, number> = {
  info: 0,
  low: 5,
  medium: 15,
  high: 35,
  critical: 60,
};

/** Hallazgos de calidad que impiden analizar bien: se pide otra foto. */
export const RETAKE_CODES = new Set([
  'image.blur',
  'image.glare',
  'image.low_resolution',
  'image.cropped',
  'image.occluded',
  'image.too_dark',
  'file.heic_unsupported',
]);

export const NO_TEMPLATE_NOTE = 'sin plantilla de referencia, confianza limitada';

export interface ScoreResult {
  score: number;
  verdict: Verdict;
  retake_required: boolean;
  confidence_note: string | null;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

function points(findings: Pick<Finding, 'severity' | 'confidence'>[]): number {
  const total = findings.reduce((s, f) => {
    const confidence = Math.min(1, Math.max(0, Number.isFinite(f.confidence) ? f.confidence : 1));
    return s + (SEVERITY_WEIGHTS[f.severity] ?? 0) * confidence;
  }, 0);
  return Math.min(100, Math.round(total));
}

function verdictFor(score: number): Verdict {
  if (score >= 70) return 'rechazar';
  if (score >= 30) return 'revisar';
  return 'aprobar';
}

/**
 * Puntaje de riesgo 0–100 y semáforo. Es determinista y auditable: el modelo de
 * lenguaje nunca lo modifica.
 */
export function scoreDocument(
  findings: Pick<Finding, 'code' | 'severity' | 'confidence'>[],
  opts: { templateMatched: boolean },
): ScoreResult {
  const score = points(findings);
  let verdict = verdictFor(score);
  if (verdict === 'aprobar' && findings.some((f) => f.severity === 'critical')) verdict = 'revisar';

  const retake = findings.some((f) => RETAKE_CODES.has(f.code) && SEVERITY_RANK[f.severity] >= SEVERITY_RANK.medium);
  if (retake) {
    // Con una foto mala las demás mediciones no son confiables: se revisa y se pide
    // otra foto, salvo que lo demás ya alcance para rechazar.
    const otherScore = points(findings.filter((f) => !RETAKE_CODES.has(f.code)));
    verdict = otherScore >= 70 ? 'rechazar' : 'revisar';
  }

  return {
    score,
    verdict,
    retake_required: retake,
    confidence_note: opts.templateMatched ? null : NO_TEMPLATE_NOTE,
  };
}
