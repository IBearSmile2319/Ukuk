import { Finding } from '../engine/engine.types';

export type RiskLevel = 'bajo' | 'medio' | 'alto';

export interface RiskInput {
  findings: Finding[];
  lateNotice: boolean;
  /** La póliza no estaba vigente en la fecha de ocurrencia o no se encontró. */
  outsideCoverage?: boolean;
}

export interface RiskAssessment {
  level: RiskLevel;
  score: number;
  reasons: string[];
  requiresAnalystReview: boolean;
}

const SEVERITY_POINTS: Record<Finding['severity'], number> = { info: 0, low: 5, medium: 15, high: 40, critical: 60 };
/** Hallazgos que por sí solos mandan el caso al analista. */
const ALWAYS_REVIEW = new Set(['foto_reutilizada', 'foto_similar', 'gps_lejano']);

/**
 * Riesgo del caso a partir de los hallazgos del motor y de la captura. Cualquier hallazgo
 * alto/crítico, foto reutilizada, GPS lejano o aviso tardío → revisión del analista.
 */
export function assessRisk(i: RiskInput): RiskAssessment {
  let score = 0;
  const reasons: string[] = [];
  let review = false;
  for (const f of i.findings) {
    score += SEVERITY_POINTS[f.severity] * Math.max(0.3, Math.min(1, f.confidence ?? 1));
    if (f.severity === 'high' || f.severity === 'critical' || f.layer === 'reuse' || ALWAYS_REVIEW.has(f.code)) {
      review = true;
      reasons.push(`${f.code}: ${f.message}`);
    }
  }
  if (i.lateNotice) {
    score += 30;
    review = true;
    reasons.push('aviso_tardio: el aviso llegó después del plazo legal');
  }
  if (i.outsideCoverage) {
    score += 30;
    review = true;
    reasons.push('fuera_de_vigencia: la ocurrencia no cae dentro de la vigencia de la póliza');
  }
  score = Math.min(100, Math.round(score));
  const level: RiskLevel = review || score >= 60 ? 'alto' : score >= 25 ? 'medio' : 'bajo';
  return { level, score, reasons: [...new Set(reasons)], requiresAnalystReview: level === 'alto' };
}
