import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable, many, one } from '../db/db.service';
import { EngineClient } from '../engine/engine.client';
import { ScreenMatch } from '../engine/engine.types';
import { Tenant } from '../tenancy/tenant';
import { AdverseMediaResult } from './adverse-media';
import { matchKey, selectNewMatches } from './dedupe';
import { Relation, computeRegime, nextReviewAt, plaftSettings } from './regime';

export const BATCH_SIZE = 500;

export const SUBJECT_COLUMNS = `id, relation, kind, name, doc_type, doc_number, birth_date::text AS birth_date, nationality,
  monitor, regime, risk_factors, dd_at, next_review_at, last_screened_at, created_at, updated_at`;

export interface SubjectRow {
  id: string;
  relation: Relation;
  kind: string;
  name: string;
  doc_type: string;
  doc_number: string;
  birth_date: string | null;
  nationality: string | null;
  monitor: boolean;
  regime: string;
  risk_factors: string[];
  dd_at: Date;
  next_review_at: Date | null;
  last_screened_at: Date | null;
}

export type ScreeningKind = 'onboarding' | 'bulk' | 'rescreen';

export interface ScreeningOutcome {
  screening_id: string | null;
  matches: number;
  new_matches: number;
  case_id: string | null;
}

/** Lógica común a la vinculación, la carga masiva y la revisión nocturna. */
@Injectable()
export class ScreeningService {
  constructor(
    private readonly db: DbService,
    private readonly engine: EngineClient,
    private readonly audit: AuditService,
  ) {}

  /** Evento en la línea de tiempo del caso, también en el registro de auditoría. */
  async caseEvent(db: Queryable, tenantId: string, caseId: string, actor: string, type: string, data: Record<string, unknown> = {}) {
    await db.query('INSERT INTO plaft_case_events (tenant_id, case_id, actor, type, data) VALUES ($1,$2,$3,$4,$5)', [
      tenantId,
      caseId,
      actor,
      type,
      data,
    ]);
    await this.audit.record(db, tenantId, { actor, action: `plaft_case.${type}`, entity: 'plaft_case', entityId: caseId, data });
  }

  /**
   * Guarda el resultado de una revisión y abre un caso solo si hay coincidencias nuevas
   * para el sujeto. En la revisión nocturna sin coincidencias no se guarda historial,
   * solo la fecha de la última revisión.
   */
  async applyResult(
    db: Queryable,
    tenant: Tenant,
    subject: Pick<SubjectRow, 'id' | 'name'>,
    r: { kind: ScreeningKind; threshold: number; query_normalized?: string | null; matches: ScreenMatch[]; adverse_media?: AdverseMediaResult | null },
    actor: string,
  ): Promise<ScreeningOutcome> {
    const existing = await many<{ source: string; entry_id: string }>(
      db,
      'SELECT source, entry_id FROM plaft_matches WHERE subject_id = $1',
      [subject.id],
    );
    const fresh = selectNewMatches(existing.map(matchKey), r.matches);
    await db.query('UPDATE plaft_subjects SET last_screened_at = now() WHERE id = $1', [subject.id]);
    if (r.kind === 'rescreen' && r.matches.length === 0) {
      return { screening_id: null, matches: 0, new_matches: 0, case_id: null };
    }

    const screening = await one<{ id: string }>(
      db,
      `INSERT INTO plaft_screenings (tenant_id, subject_id, kind, threshold, query_normalized, matches, new_matches, adverse_media)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        tenant.id,
        subject.id,
        r.kind,
        r.threshold,
        r.query_normalized ?? null,
        JSON.stringify(r.matches),
        fresh.length,
        r.adverse_media ?? null,
      ],
    );
    let caseId: string | null = null;
    if (fresh.length) {
      const c = await one<{ id: string }>(
        db,
        `INSERT INTO plaft_cases (tenant_id, subject_id, screening_id, origin) VALUES ($1,$2,$3,$4) RETURNING id`,
        [tenant.id, subject.id, screening!.id, r.kind],
      );
      caseId = c!.id;
      for (const m of fresh) {
        await db.query(
          `INSERT INTO plaft_matches (tenant_id, subject_id, screening_id, case_id, source, category, entry_id, matched_name, score, data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tenant_id, subject_id, source, entry_id) DO NOTHING`,
          [tenant.id, subject.id, screening!.id, caseId, m.source, m.category, m.entry_id, m.matched_name ?? m.name, m.score, m],
        );
      }
      await this.caseEvent(db, tenant.id, caseId, actor, 'opened', {
        subject_id: subject.id,
        subject_name: subject.name,
        origin: r.kind,
        screening_id: screening!.id,
        matches: fresh.map((m) => ({ source: m.source, category: m.category, entry_id: m.entry_id, name: m.name, score: m.score })),
      });
    }
    return { screening_id: screening!.id, matches: r.matches.length, new_matches: fresh.length, case_id: caseId };
  }

  /** Recalcula régimen y próxima revisión con las coincidencias vigentes. */
  async refreshRegime(db: Queryable, tenant: Tenant, subjectId: string): Promise<SubjectRow> {
    const s = plaftSettings(tenant.settings);
    const subject = await one<SubjectRow>(db, `SELECT ${SUBJECT_COLUMNS} FROM plaft_subjects WHERE id = $1`, [subjectId]);
    const matches = await many<{ category: string; status: string }>(
      db,
      'SELECT category, status FROM plaft_matches WHERE subject_id = $1',
      [subjectId],
    );
    const media = await one<{ relevant: number }>(
      db,
      `SELECT (adverse_media->>'relevant')::int AS relevant FROM plaft_screenings
        WHERE subject_id = $1 AND adverse_media IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [subjectId],
    );
    const { regime, factors } = computeRegime({ matches, nationality: subject!.nationality, adverseMedia: (media?.relevant ?? 0) > 0 }, s);
    const next = nextReviewAt(new Date(subject!.dd_at), subject!.relation, regime, s);
    return (await one<SubjectRow>(
      db,
      `UPDATE plaft_subjects SET regime = $2, risk_factors = $3, next_review_at = $4, updated_at = now()
        WHERE id = $1 RETURNING ${SUBJECT_COLUMNS}`,
      [subjectId, regime, JSON.stringify(factors), next],
    ))!;
  }

  /**
   * Revisa contra las listas toda la cartera monitoreada del cliente, por lotes de 500.
   * Solo abre casos por coincidencias nuevas.
   */
  async rescreenTenant(tenant: Tenant, actor: string) {
    const threshold = plaftSettings(tenant.settings).threshold;
    const subjects = await this.db.withTenant(tenant.id, (db) =>
      many<SubjectRow>(db, `SELECT ${SUBJECT_COLUMNS} FROM plaft_subjects WHERE monitor ORDER BY created_at, id`),
    );
    const summary = { subjects: subjects.length, with_matches: 0, new_matches: 0, cases_opened: 0 };
    for (let i = 0; i < subjects.length; i += BATCH_SIZE) {
      const chunk = subjects.slice(i, i + BATCH_SIZE);
      const res = await this.engine.screenBatch({
        threshold,
        subjects: chunk.map((s) => ({
          ref: s.id,
          name: s.name,
          kind: s.kind as 'individual' | 'entity',
          ...(s.birth_date ? { birth_date: s.birth_date } : {}),
          ...(s.nationality ? { nationality: s.nationality } : {}),
        })),
      });
      const byRef = new Map(res.results.map((r) => [r.ref, r.matches]));
      await this.db.withTenant(tenant.id, async (db) => {
        for (const s of chunk) {
          const matches = byRef.get(s.id) ?? [];
          const out = await this.applyResult(db, tenant, s, { kind: 'rescreen', threshold, matches }, actor);
          if (out.matches) summary.with_matches++;
          summary.new_matches += out.new_matches;
          if (out.case_id) {
            summary.cases_opened++;
            await this.refreshRegime(db, tenant, s.id);
          }
        }
      });
    }
    await this.db.withTenant(tenant.id, (db) =>
      this.audit.record(db, tenant.id, { actor, action: 'plaft.portfolio_rescreened', entity: 'plaft_portfolio', data: summary }),
    );
    return summary;
  }
}
