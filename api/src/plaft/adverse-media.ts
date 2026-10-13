import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { LlmService } from '../llm/llm.service';

export interface AdverseArticle {
  title: string;
  url: string;
  source: string;
  published_at: string | null;
  snippet: string;
}

export interface AdverseMediaProvider {
  readonly name: string;
  search(query: { name: string; kind: string }): Promise<AdverseArticle[]>;
}

export const ADVERSE_MEDIA_PROVIDER = Symbol('ADVERSE_MEDIA_PROVIDER');

/**
 * Proveedor vacío mientras no haya fuente de noticias contratada.
 * TODO: implementar con la API DOC 2.0 de GDELT (sourcecountry:PE, sourcelang:spanish) o
 * Google News RSS (hl=es-419&gl=PE) filtrando medios peruanos, combinando el nombre con
 * términos como "lavado", "fiscalía", "detenido", "corrupción". Revisar los términos de uso
 * de cada fuente antes de activarla.
 */
export class StubAdverseMediaProvider implements AdverseMediaProvider {
  readonly name = 'stub';

  async search(): Promise<AdverseArticle[]> {
    return [];
  }
}

export const JudgmentSchema = z.object({
  same_person: z.boolean(),
  confidence: z.number(),
  reason: z.string(),
});
export type Judgment = z.infer<typeof JudgmentSchema>;

export interface AdverseMediaResult {
  provider: string;
  searched_at: string;
  articles: (AdverseArticle & { judgment: Judgment | null })[];
  /** Noticias que el modelo considera sobre la misma persona (confianza ≥ 0.7). */
  relevant: number;
  /** Hay noticias sin juzgar: las revisa el oficial de cumplimiento. */
  needs_review: boolean;
  error?: string;
}

export interface AdverseSubject {
  name: string;
  kind: string;
  doc_type: string;
  doc_number: string;
  birth_date?: string | null;
  nationality?: string | null;
}

const SYSTEM = `Eres analista de cumplimiento PLAFT en Perú. Decide si una noticia trata sobre la
misma persona o empresa que el sujeto revisado, considerando homónimos frecuentes en apellidos
peruanos. Usa solo los datos dados (nombre, documento, fecha de nacimiento, nacionalidad y el
texto de la noticia). Si no hay datos suficientes, responde same_person=false con confianza baja.
La razón va en español y en una o dos oraciones.`;

const MAX_ARTICLES = 10;

@Injectable()
export class AdverseMediaService {
  private readonly logger = new Logger(AdverseMediaService.name);

  constructor(
    @Inject(ADVERSE_MEDIA_PROVIDER) private readonly provider: AdverseMediaProvider,
    private readonly llm: LlmService,
  ) {}

  async check(subject: AdverseSubject): Promise<AdverseMediaResult> {
    const searched_at = new Date().toISOString();
    let found: AdverseArticle[];
    try {
      found = (await this.provider.search({ name: subject.name, kind: subject.kind })).slice(0, MAX_ARTICLES);
    } catch (err) {
      this.logger.warn(`Búsqueda de noticias falló: ${(err as Error).message}`);
      return { provider: this.provider.name, searched_at, articles: [], relevant: 0, needs_review: false, error: (err as Error).message };
    }
    const articles = [];
    for (const a of found) articles.push({ ...a, judgment: await this.judge(subject, a) });
    const relevant = articles.filter((a) => a.judgment?.same_person && a.judgment.confidence >= 0.7).length;
    return {
      provider: this.provider.name,
      searched_at,
      articles,
      relevant,
      needs_review: articles.some((a) => a.judgment === null),
    };
  }

  private judge(subject: AdverseSubject, article: AdverseArticle): Promise<Judgment | null> {
    if (!this.llm.enabled) return Promise.resolve(null);
    return this.llm.structured({
      system: SYSTEM,
      prompt: JSON.stringify({ sujeto: subject, noticia: article }, null, 2),
      schema: JudgmentSchema,
      effort: 'low',
      maxTokens: 1000,
    });
  }
}
