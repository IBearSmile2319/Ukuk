import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { toCsv } from '../common/csv';
import { DbService, Queryable, many, one } from '../db/db.service';
import { LlmService } from '../llm/llm.service';
import { Tenant } from '../tenancy/tenant';
import { TenantsService } from '../tenancy/tenants.service';
import { Article } from './classifier';
import { templateCommentDraft } from './comment-draft';
import { MatrixQueryDto, UpdateImpactDto } from './dto';
import { MatchNorm, MatchProcess, ProcessMatch, TenantProfile, isNormRelevant, matchProcesses } from './matching';
import { addDays } from './text';

const ImpactLlmSchema = z.object({
  results: z.array(
    z.object({ process_code: z.string(), applies: z.boolean(), articles: z.array(z.string()), rationale: z.string() }),
  ),
});

const CommentLlmSchema = z.object({ draft: z.string() });

interface NormRow extends MatchNorm {
  id: string;
  number: string | null;
  effective_at: string | null;
}

/** Hoy en Lima (UTC-5, sin horario de verano). */
export function limaToday(now = new Date()): string {
  return new Date(now.getTime() - 5 * 3600_000).toISOString().slice(0, 10);
}

@Injectable()
export class ImpactsService {
  private readonly logger = new Logger(ImpactsService.name);

  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantsService,
    private readonly audit: AuditService,
    private readonly llm: LlmService,
  ) {}

  private async loadNorms(ids: string[]): Promise<NormRow[]> {
    if (!ids.length) return [];
    const rows = await this.db.query(
      `SELECT id, number, title, text, scope, topics, entity_types, articles,
              to_char(effective_at,'YYYY-MM-DD') AS effective_at
         FROM reg_norms WHERE id = ANY($1)`,
      [ids],
    );
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      text: r.text,
      scope: r.scope,
      topics: r.topics,
      entityTypes: r.entity_types,
      articles: r.articles as Article[],
      effective_at: r.effective_at,
    }));
  }

  private async loadProcesses(db: Queryable): Promise<MatchProcess[]> {
    return many(db, 'SELECT id, code, name, description, topics, keywords FROM reg_processes ORDER BY code');
  }

  profile(tenant: Tenant, processes: MatchProcess[]): TenantProfile {
    return { entityType: tenant.entityType, topics: [...new Set([...tenant.businessLines, ...processes.flatMap((p) => p.topics)])] };
  }

  /** Devuelve, por norma, cuántos clientes quedaron con al menos un impacto. */
  async computeForAllTenants(normIds: string[]): Promise<Map<string, number>> {
    const norms = await this.loadNorms(normIds);
    const counts = new Map<string, number>();
    for (const tenant of await this.tenants.listActive('regulatory')) {
      try {
        const perNorm = await this.db.withTenant(tenant.id, (db) => this.computeForTenant(db, tenant, norms));
        for (const [id, n] of perNorm) if (n > 0) counts.set(id, (counts.get(id) ?? 0) + 1);
      } catch (err) {
        this.logger.error(`Impactos del cliente ${tenant.id}: ${(err as Error).message}`);
      }
    }
    return counts;
  }

  /** Recalcula contra las normas generales recientes o aún no vigentes (tras cambiar el inventario). */
  async recomputeTenant(tenant: Tenant): Promise<number> {
    const ids = await this.db.query<{ id: string }>(
      `SELECT id FROM reg_norms
        WHERE scope = 'general' AND (published_at >= current_date - 365 OR effective_at >= current_date
              OR (status = 'proyecto' AND comments_deadline >= current_date))`,
    );
    const norms = await this.loadNorms(ids.map((r) => r.id));
    const perNorm = await this.db.withTenant(tenant.id, (db) => this.computeForTenant(db, tenant, norms));
    return [...perNorm.values()].reduce((s, n) => s + n, 0);
  }

  private async computeForTenant(db: Queryable, tenant: Tenant, norms: NormRow[]): Promise<Map<string, number>> {
    const processes = await this.loadProcesses(db);
    const profile = this.profile(tenant, processes);
    const threshold = Number(tenant.settings.regulatory_threshold ?? '') || undefined;
    const out = new Map<string, number>();
    for (const norm of norms) {
      let matches = matchProcesses(norm, profile, processes, { threshold });
      let method = 'reglas';
      if (matches.length && this.llm.enabled) {
        const refined = await this.refine(norm, processes, matches);
        if (refined) {
          matches = refined;
          method = 'llm';
        }
      }
      const kept: string[] = [];
      let created = 0;
      for (const m of matches) {
        const row = await one<{ created: boolean }>(
          db,
          `INSERT INTO reg_impacts (tenant_id, norm_id, process_id, score, matched_articles, rationale, method, effective_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (tenant_id, norm_id, process_id) DO UPDATE SET
             score = EXCLUDED.score, matched_articles = EXCLUDED.matched_articles, rationale = EXCLUDED.rationale,
             method = EXCLUDED.method, effective_at = EXCLUDED.effective_at, updated_at = now()
           RETURNING (xmax = 0) AS created`,
          [tenant.id, norm.id, m.processId, m.score, JSON.stringify(m.articles), m.rationale, method, norm.effective_at],
        );
        kept.push(m.processId);
        if (row?.created) created++;
      }
      // Solo se borran impactos que nadie tocó todavía.
      const removed = await db.query(
        `DELETE FROM reg_impacts i WHERE norm_id = $1 AND status = 'pendiente' AND NOT (process_id = ANY($2::uuid[]))
           AND NOT EXISTS (SELECT 1 FROM reg_tasks t WHERE t.impact_id = i.id)`,
        [norm.id, kept],
      );
      if (created || removed.rowCount) {
        await this.audit.record(db, tenant.id, {
          actor: 'system',
          action: 'regulatory.impacts_computed',
          entity: 'reg_norm',
          entityId: norm.id,
          data: { created, removed: removed.rowCount ?? 0, processes: matches.map((m) => m.processCode), method },
        });
      }
      out.set(norm.id, matches.length);
    }
    return out;
  }

  /** Claude confirma o descarta cada par norma × proceso candidato. */
  private async refine(norm: NormRow, processes: MatchProcess[], matches: ProcessMatch[]): Promise<ProcessMatch[] | null> {
    const byCode = new Map(processes.map((p) => [p.code, p]));
    const res = await this.llm.structured({
      system:
        'Eres analista de cumplimiento en Perú. Decides si un artículo de una norma obliga a cambiar una política o ' +
        'proceso interno de la entidad. Sé estricto: "applies" solo si hay una obligación concreta. Responde en español.',
      prompt: [
        `Norma: ${norm.number ?? ''} ${norm.title}`,
        'Artículos:',
        ...norm.articles.slice(0, 80).map((a) => `- ${a.number}: ${a.text.slice(0, 1500)}`),
        '',
        'Procesos candidatos:',
        ...matches.map((m) => {
          const p = byCode.get(m.processCode)!;
          return `- ${p.code} | ${p.name} | ${p.description.slice(0, 1000)} | artículos sugeridos: ${m.articles.map((a) => a.number).join(', ')}`;
        }),
      ].join('\n'),
      schema: ImpactLlmSchema,
      effort: 'medium',
      maxTokens: 6000,
    });
    if (!res) return null;
    const verdicts = new Map(res.results.map((r) => [r.process_code, r]));
    const articles = new Map(norm.articles.map((a) => [a.number, a]));
    return matches.flatMap((m) => {
      const v = verdicts.get(m.processCode);
      if (!v) return [m];
      if (!v.applies) return [];
      const arts = v.articles
        .filter((n) => articles.has(n))
        .map((n) => m.articles.find((a) => a.number === n) ?? {
          number: n,
          score: 0,
          keywords: [],
          excerpt: articles.get(n)!.text.replace(/\s+/g, ' ').slice(0, 280),
        });
      return [{ ...m, articles: arts.length ? arts : m.articles, rationale: v.rationale }];
    });
  }

  async listForNorm(tenant: Tenant, normId: string) {
    return this.db.withTenant(tenant.id, (db) =>
      many(
        db,
        `SELECT i.id, p.code AS process_code, p.name AS process_name, p.kind AS process_kind, p.owner_email,
                i.score, i.matched_articles, i.rationale, i.method, to_char(i.effective_at,'YYYY-MM-DD') AS effective_at,
                i.status, i.status_note
           FROM reg_impacts i JOIN reg_processes p ON p.id = i.process_id
          WHERE i.norm_id = $1 ORDER BY i.score DESC`,
        [normId],
      ),
    );
  }

  async updateStatus(tenant: Tenant, id: string, dto: UpdateImpactDto, actor: string) {
    return this.db.withTenant(tenant.id, async (db) => {
      const before = await one(db, 'SELECT status FROM reg_impacts WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw new NotFoundException('Impacto no encontrado');
      const row = await one(
        db,
        `UPDATE reg_impacts SET status = $2, status_note = COALESCE($3, status_note), updated_at = now()
          WHERE id = $1 RETURNING id, status, status_note`,
        [id, dto.status, dto.note ?? null],
      );
      await this.audit.record(db, tenant.id, {
        actor,
        action: 'regulatory.impact_status',
        entity: 'reg_impact',
        entityId: id,
        data: { from: before.status, to: dto.status, note: dto.note ?? null },
      });
      return row;
    });
  }

  async matrix(tenant: Tenant, q: MatrixQueryDto) {
    const rows = await this.db.withTenant(tenant.id, (db) =>
      many(
        db,
        `SELECT i.id AS impact_id, n.id AS norm_id, n.number AS norm_number, n.title AS norm_title,
                to_char(n.published_at,'YYYY-MM-DD') AS published_at, to_char(i.effective_at,'YYYY-MM-DD') AS effective_at,
                p.code AS process_code, p.name AS process_name, p.kind AS process_kind, p.owner_email,
                i.score, i.matched_articles, i.status,
                (SELECT count(*)::int FROM reg_tasks t WHERE t.impact_id = i.id AND t.status <> 'cerrada') AS open_tasks
           FROM reg_impacts i
           JOIN reg_norms n ON n.id = i.norm_id
           JOIN reg_processes p ON p.id = i.process_id
          WHERE ($1::text IS NULL OR i.status = $1) AND ($2::uuid IS NULL OR i.norm_id = $2)
            AND ($3::text IS NULL OR p.code = $3)
          ORDER BY i.effective_at NULLS LAST, n.published_at DESC, p.code`,
        [q.status ?? null, q.norm_id ?? null, q.process_code ?? null],
      ),
    );
    // Una fila por artículo × proceso.
    return rows.flatMap((r) => {
      const arts = (r.matched_articles as { number: string; excerpt: string }[]).length
        ? (r.matched_articles as { number: string; excerpt: string }[])
        : [{ number: '-', excerpt: '' }];
      const { matched_articles, ...rest } = r;
      return arts.map((a) => ({ ...rest, article: a.number, article_excerpt: a.excerpt }));
    });
  }

  matrixCsv(rows: Awaited<ReturnType<ImpactsService['matrix']>>): string {
    return toCsv(
      ['norma', 'titulo', 'articulo', 'proceso_codigo', 'proceso', 'tipo', 'responsable', 'relevancia', 'vigencia', 'estado', 'tareas_abiertas'],
      rows.map((r) => [
        r.norm_number ?? '',
        r.norm_title,
        r.article,
        r.process_code,
        r.process_name,
        r.process_kind,
        r.owner_email ?? '',
        r.score,
        r.effective_at ?? '',
        r.status,
        r.open_tasks,
      ]),
    );
  }

  /** Resumen diario: normas generales nuevas relevantes, impactos, consultas abiertas y vencimientos. */
  async digest(tenant: Tenant, date = limaToday()) {
    const norms = await this.db.query(
      `SELECT id, source, number, title, summary, url, scope, status, topics, entity_types,
              to_char(published_at,'YYYY-MM-DD') AS published_at, to_char(effective_at,'YYYY-MM-DD') AS effective_at,
              to_char(comments_deadline,'YYYY-MM-DD') AS comments_deadline
         FROM reg_norms
        WHERE scope = 'general' AND (published_at = $1 OR (status = 'proyecto' AND comments_deadline >= $1 AND published_at <= $1))
        ORDER BY published_at DESC`,
      [date],
    );
    return this.db.withTenant(tenant.id, async (db) => {
      const processes = await this.loadProcesses(db);
      const profile = this.profile(tenant, processes);
      const relevant = norms.filter((n) => isNormRelevant({ scope: n.scope, topics: n.topics, entityTypes: n.entity_types }, profile));
      const impacts = relevant.length
        ? await many(
            db,
            `SELECT i.id, i.norm_id, p.code AS process_code, p.name AS process_name, i.score, i.matched_articles, i.status
               FROM reg_impacts i JOIN reg_processes p ON p.id = i.process_id
              WHERE i.norm_id = ANY($1) ORDER BY i.score DESC`,
            [relevant.map((n) => n.id)],
          )
        : [];
      const withImpacts = (n: (typeof norms)[number]) => ({
        id: n.id,
        source: n.source,
        number: n.number,
        title: n.title,
        summary: n.summary,
        url: n.url,
        topics: n.topics,
        published_at: n.published_at,
        effective_at: n.effective_at,
        impacts: impacts
          .filter((i) => i.norm_id === n.id)
          .map(({ norm_id, matched_articles, ...i }) => ({
            ...i,
            articles: (matched_articles as { number: string }[]).map((a) => a.number),
          })),
      });
      const upcoming = await many(
        db,
        `SELECT i.id, n.number AS norm_number, n.title AS norm_title, p.code AS process_code,
                to_char(i.effective_at,'YYYY-MM-DD') AS effective_at, i.status
           FROM reg_impacts i JOIN reg_norms n ON n.id = i.norm_id JOIN reg_processes p ON p.id = i.process_id
          WHERE i.effective_at BETWEEN $1::date AND $1::date + 30 AND i.status IN ('pendiente','en_adecuacion')
          ORDER BY i.effective_at`,
        [date],
      );
      const overdue = await one<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM reg_tasks WHERE status <> 'cerrada' AND due_at < $1`,
        [date],
      );
      return {
        date,
        tenant: tenant.name,
        new_norms: relevant.filter((n) => n.published_at === date && n.status === 'vigente').map(withImpacts),
        consultations: relevant
          .filter((n) => n.status === 'proyecto')
          .map((n) => ({
            ...withImpacts(n),
            comments_deadline: n.comments_deadline,
            days_left: n.comments_deadline
              ? Math.round((Date.parse(n.comments_deadline) - Date.parse(date)) / 86_400_000)
              : null,
          })),
        upcoming_effective: upcoming,
        overdue_tasks: overdue?.n ?? 0,
        window_end: addDays(date, 30),
      };
    });
  }

  async commentDraft(tenant: Tenant, norm: Record<string, any>, actor: string) {
    if (norm.status !== 'proyecto') throw new BadRequestException('Solo se redactan comentarios para proyectos de norma');
    const impacts = await this.listForNorm(tenant, norm.id);
    const draftImpacts = impacts.map((i) => ({
      process_code: i.process_code,
      process_name: i.process_name,
      articles: (i.matched_articles as { number: string; excerpt: string }[]).map((a) => ({ number: a.number, excerpt: a.excerpt })),
    }));
    let draft: string | null = null;
    let method = 'plantilla';
    if (this.llm.enabled) {
      const out = await this.llm.structured({
        system:
          'Eres abogado regulatorio en Perú. Redactas comentarios formales y técnicos que una entidad supervisada envía ' +
          'a la SBS sobre un proyecto de norma prepublicado. Español formal, por artículo, con propuesta de redacción. ' +
          'No inventes datos de la entidad: usa marcadores entre corchetes donde falte información.',
        prompt: [
          `Entidad: ${tenant.name} (${tenant.entityType})`,
          `Proyecto: ${norm.number ?? ''} ${norm.title}`,
          `Plazo de comentarios: ${norm.comments_deadline ?? 'no indicado'}`,
          '',
          'Procesos internos afectados y artículos:',
          ...draftImpacts.map((i) => `- ${i.process_code} ${i.process_name}: ${i.articles.map((a) => `${a.number} (${a.excerpt})`).join('; ')}`),
          '',
          `Texto del proyecto:\n${String(norm.text ?? '').slice(0, 50_000)}`,
        ].join('\n'),
        schema: CommentLlmSchema,
        effort: 'medium',
        maxTokens: 8000,
      });
      if (out?.draft) {
        draft = out.draft;
        method = 'llm';
      }
    }
    draft ??= templateCommentDraft({ tenantName: tenant.name, norm: norm as any, impacts: draftImpacts });
    await this.db.withTenant(tenant.id, (db) =>
      this.audit.record(db, tenant.id, {
        actor,
        action: 'regulatory.comment_draft',
        entity: 'reg_norm',
        entityId: norm.id,
        data: { method, impacts: draftImpacts.length },
      }),
    );
    return { norm_id: norm.id, comments_deadline: norm.comments_deadline, method, format: 'markdown', draft, impacts: draftImpacts };
  }
}
