import { z } from 'zod';
import { Finding } from '../engine/engine.types';
import { LlmService } from '../llm/llm.service';
import { ScoreResult } from './scoring';

export const ExplanationSchema = z.object({
  summary: z.string(),
  per_finding: z.array(z.object({ code: z.string(), explanation: z.string() })),
});
export type Explanation = z.infer<typeof ExplanationSchema>;

const SYSTEM = `Eres analista antifraude documental en Perú. Recibes solo mediciones deterministas
de un documento (hallazgos con código, severidad, confianza y evidencia numérica) y el puntaje ya
calculado. Redacta en español, claro y breve, para un analista de seguros o banca. No inventes
hallazgos ni cambies el puntaje o el veredicto: solo explica lo que miden los datos y qué conviene
revisar. Si no hay hallazgos, dilo.`;

/** Explicación redactada por Claude. Nunca cambia el puntaje ni el veredicto; null si está desactivado. */
export async function explainFindings(
  llm: LlmService,
  input: { documentType: string | null; findings: Finding[]; score: ScoreResult; templateLabel: string | null },
): Promise<Explanation | null> {
  if (!llm.enabled) return null;
  const payload = {
    tipo_documento: input.documentType,
    plantilla: input.templateLabel,
    puntaje: input.score.score,
    veredicto: input.score.verdict,
    pedir_otra_foto: input.score.retake_required,
    nota: input.score.confidence_note,
    hallazgos: input.findings.map((f) => ({
      code: f.code,
      capa: f.layer,
      severidad: f.severity,
      confianza: f.confidence,
      mensaje: f.message,
      evidencia: f.evidence ?? null,
    })),
  };
  return llm.structured({
    system: SYSTEM,
    prompt: `Mediciones del documento:\n${JSON.stringify(payload, null, 2)}\n\nEscribe un resumen y una explicación por cada código de hallazgo.`,
    schema: ExplanationSchema,
    effort: 'low',
    maxTokens: 4000,
  });
}
