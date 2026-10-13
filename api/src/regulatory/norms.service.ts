import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { LlmService } from '../llm/llm.service';
import { ENTITY_TYPES } from '../tenancy/tenant';
import { Classification, REG_TOPICS, classifyNorm } from './classifier';
import { NormInputDto, NormsQueryDto } from './dto';
import { ImpactsService } from './impacts.service';
import { RawNorm } from './sources/source-adapter';

const NormLlmSchema = z.object({
  scope: z.enum(['general', 'particular']),
  topics: z.array(z.enum(REG_TOPICS)),
  entity_types: z.array(z.enum(ENTITY_TYPES)),
  summary: z.string(),
  effective_at: z.string().nullable(),
  obligations: z.array(z.object({ article: z.string(), obligation: z.string(), deadline: z.string().nullable() })),
});

const NORM_COLUMNS = `id, source, external_id, issuer, number, title, summary, to_char(published_at,'YYYY-MM-DD') AS published_at,
  to_char(effective_at,'YYYY-MM-DD') AS effective_at, url, pdf_url, scope, status,
  to_char(comments_deadline,'YYYY-MM-DD') AS comments_deadline, entity_types, topics, classification`;

export interface IngestResult {
  id: string;
  external_id: string;
  created: boolean;
  scope: string;
  status: string;
  topics: string[];
  tenants_with_impacts: number;
}

export function rawToInput(r: RawNorm): NormInputDto {
  return {
    source: r.source,
    external_id: r.externalId,
    issuer: r.issuer,
    number: r.number,
    title: r.title,
    published_at: r.publishedAt,
    url: r.url,
    pdf_url: r.pdfUrl,
    text: r.text,
    status: r.status,
    comments_deadline: r.commentsDeadline,
  };
}

/** Normas globales: ingesta, clasificación y consulta. */
@Injectable()
export class NormsService {
  private readonly logger = new Logger(NormsService.name);

  constructor(
    private readonly db: DbService,
    private readonly llm: LlmService,
    private readonly impacts: ImpactsService,
  ) {}

  /** Clasifica con reglas y, si Claude está activo, refina. Los campos explícitos mandan. */
  async classify(n: NormInputDto): Promise<Classification & { method: 'reglas' | 'llm' }> {
    const c = classifyNorm({ title: n.title, text: n.text, publishedAt: n.published_at });
    if (n.articles?.length) c.articles = n.articles;
    let method: 'reglas' | 'llm' = 'reglas';
    // Las particulares por patrón claro no pasan por el modelo: son la mayoría y no aportan.
    const worthLlm = n.text && (c.scope === 'general' || c.scopeReason.includes('se asume'));
    if (this.llm.enabled && worthLlm) {
      const out = await this.llm.structured({
        system:
          'Eres analista de cumplimiento regulatorio en Perú. Clasificas normas de la SBS y otros reguladores. ' +
          'Una norma es "general" si obliga a un conjunto de entidades; "particular" si se dirige a una empresa o persona. ' +
          'Responde en español. El resumen tiene como máximo 80 palabras. Fechas en formato YYYY-MM-DD.',
        prompt: `Título: ${n.title}\nFecha de publicación: ${n.published_at}\n\nTexto:\n${n.text!.slice(0, 60_000)}`,
        schema: NormLlmSchema,
        effort: 'low',
        maxTokens: 4000,
      });
      if (out) {
        method = 'llm';
        c.scope = out.scope;
        c.topics = out.topics;
        c.entityTypes = out.entity_types;
        c.summary = out.summary.split(/\s+/).slice(0, 80).join(' ');
        if (out.effective_at && /^\d{4}-\d{2}-\d{2}$/.test(out.effective_at)) c.effectiveAt = out.effective_at;
        if (out.obligations.length) c.obligations = out.obligations;
      }
    }
    if (n.scope) c.scope = n.scope;
    if (n.status) c.status = n.status;
    if (n.comments_deadline) c.commentsDeadline = n.comments_deadline;
    if (n.topics) c.topics = n.topics;
    if (n.entity_types) c.entityTypes = n.entity_types;
    if (n.effective_at) c.effectiveAt = n.effective_at;
    if (n.summary) c.summary = n.summary;
    return { ...c, method };
  }

  /** Inserta o actualiza las normas y calcula impactos para todos los clientes del servicio. */
  async ingest(inputs: NormInputDto[]): Promise<IngestResult[]> {
    const results: IngestResult[] = [];
    const changed: string[] = [];
    for (const n of inputs) {
      const c = await this.classify(n);
      const rows = await this.db.query<{ id: string; created: boolean }>(
        `INSERT INTO reg_norms (source, external_id, issuer, number, title, summary, published_at, effective_at, url, pdf_url,
                                text, scope, status, comments_deadline, entity_types, topics, articles, classification)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (source, external_id) DO UPDATE SET
           issuer = EXCLUDED.issuer, number = EXCLUDED.number, title = EXCLUDED.title, summary = EXCLUDED.summary,
           published_at = EXCLUDED.published_at, effective_at = EXCLUDED.effective_at, url = EXCLUDED.url,
           pdf_url = EXCLUDED.pdf_url, text = EXCLUDED.text, scope = EXCLUDED.scope, status = EXCLUDED.status,
           comments_deadline = EXCLUDED.comments_deadline, entity_types = EXCLUDED.entity_types,
           topics = EXCLUDED.topics, articles = EXCLUDED.articles, classification = EXCLUDED.classification,
           updated_at = now()
         RETURNING id, (xmax = 0) AS created`,
        [
          n.source,
          n.external_id,
          n.issuer ?? null,
          n.number ?? null,
          n.title,
          c.summary || null,
          n.published_at,
          c.effectiveAt,
          n.url ?? null,
          n.pdf_url ?? null,
          n.text ?? null,
          c.scope,
          c.status,
          c.commentsDeadline,
          c.entityTypes,
          c.topics,
          JSON.stringify(c.articles),
          {
            method: c.method,
            scope_reason: c.scopeReason,
            effective_phrase: c.effectivePhrase,
            obligations: c.obligations,
          },
        ],
      );
      const row = rows[0];
      results.push({
        id: row.id,
        external_id: n.external_id,
        created: row.created,
        scope: c.scope,
        status: c.status,
        topics: c.topics,
        tenants_with_impacts: 0,
      });
      changed.push(row.id);
    }
    // Se recalcula siempre: una norma reingresada puede cambiar de texto o clasificación.
    const perNorm = await this.impacts.computeForAllTenants(changed);
    for (const r of results) r.tenants_with_impacts = perNorm.get(r.id) ?? 0;
    this.logger.log(`Normas ingresadas: ${results.length} (${results.filter((r) => r.created).length} nuevas)`);
    return results;
  }

  list(q: NormsQueryDto) {
    return this.db.query(
      `SELECT ${NORM_COLUMNS}${q.q ? `, ts_rank(search, websearch_to_tsquery('spanish', $7)) AS rank` : ''}
         FROM reg_norms
        WHERE ($1::date IS NULL OR published_at >= $1) AND ($2::date IS NULL OR published_at <= $2)
          AND ($3::text IS NULL OR $3 = ANY(topics)) AND ($4::text IS NULL OR scope = $4)
          AND ($5::text IS NULL OR status = $5) AND ($6::text IS NULL OR source = $6)
          AND ($7::text IS NULL OR search @@ websearch_to_tsquery('spanish', $7))
        ORDER BY ${q.q ? 'rank DESC,' : ''} published_at DESC, id
        LIMIT $8 OFFSET $9`,
      [
        q.from ?? null,
        q.to ?? null,
        q.topic ?? null,
        q.scope ?? null,
        q.status ?? null,
        q.source ?? null,
        q.q ?? null,
        q.limit ?? 50,
        q.offset ?? 0,
      ],
    );
  }

  async get(id: string, withText = true) {
    const rows = await this.db.query(
      `SELECT ${NORM_COLUMNS}${withText ? ', text, articles' : ', articles'} FROM reg_norms WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Norma no encontrada');
    return rows[0];
  }
}
