import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable, many, one } from '../db/db.service';
import { EngineClient } from '../engine/engine.client';
import { Tenant } from '../tenancy/tenant';
import { UsageService } from '../usage/usage.service';
import { AdverseMediaService } from './adverse-media';
import { CsvHeaderError, CsvSubject, parseSubjectsCsv } from './csv';
import { CreateSubjectDto, ListSubjectsQuery, ReportQuery } from './dto';
import { DocType, Kind, docNumberError, plaftSettings } from './regime';
import { BATCH_SIZE, SUBJECT_COLUMNS, ScreeningService, SubjectRow } from './screening.service';

@Injectable()
export class SubjectsService {
  constructor(
    private readonly db: DbService,
    private readonly engine: EngineClient,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly screening: ScreeningService,
    private readonly adverseMedia: AdverseMediaService,
  ) {}

  private async validateDoc(kind: Kind, docType: DocType, docNumber: string): Promise<string | null> {
    const err = docNumberError(kind, docType, docNumber);
    if (err) return err;
    if (docType === 'RUC') {
      const r = await this.engine.validateRuc(docNumber);
      if (!r.valid) return `El RUC ${docNumber} no es válido (dígito de control)`;
    }
    return null;
  }

  /** Vinculación: valida, revisa contra listas y noticias, calcula régimen y abre caso si hay coincidencias. */
  async create(tenant: Tenant, dto: CreateSubjectDto, actor: string) {
    const docErr = await this.validateDoc(dto.kind, dto.doc_type, dto.doc_number);
    if (docErr) throw new BadRequestException(docErr);
    const dup = await this.db.withTenant(tenant.id, (db) =>
      one<{ id: string }>(db, 'SELECT id FROM plaft_subjects WHERE relation = $1 AND doc_type = $2 AND doc_number = $3', [
        dto.relation,
        dto.doc_type,
        dto.doc_number,
      ]),
    );
    if (dup) throw new ConflictException(`El sujeto ya está registrado con esa relación (id ${dup.id})`);

    const threshold = plaftSettings(tenant.settings).threshold;
    const res = await this.engine.screen({
      name: dto.name,
      kind: dto.kind,
      threshold,
      ...(dto.birth_date ? { birth_date: dto.birth_date } : {}),
      ...(dto.nationality ? { nationality: dto.nationality } : {}),
    });
    const media = await this.adverseMedia.check({
      name: dto.name,
      kind: dto.kind,
      doc_type: dto.doc_type,
      doc_number: dto.doc_number,
      birth_date: dto.birth_date ?? null,
      nationality: dto.nationality ?? null,
    });

    return this.db.withTenant(tenant.id, async (db) => {
      const inserted = await one<SubjectRow>(
        db,
        `INSERT INTO plaft_subjects (tenant_id, relation, kind, name, doc_type, doc_number, birth_date, nationality, monitor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id, relation, doc_type, doc_number) DO NOTHING RETURNING ${SUBJECT_COLUMNS}`,
        [
          tenant.id,
          dto.relation,
          dto.kind,
          dto.name.trim(),
          dto.doc_type,
          dto.doc_number,
          dto.birth_date ?? null,
          dto.nationality ?? null,
          dto.monitor ?? true,
        ],
      );
      if (!inserted) throw new ConflictException('El sujeto ya está registrado con esa relación');
      const out = await this.screening.applyResult(
        db,
        tenant,
        inserted,
        { kind: 'onboarding', threshold, query_normalized: res.query_normalized, matches: res.matches, adverse_media: media },
        actor,
      );
      const subject = await this.screening.refreshRegime(db, tenant, inserted.id);
      await this.usage.record(db, tenant.id, 'plaft', 'onboarding_check', 1, inserted.id);
      await this.audit.record(db, tenant.id, {
        actor,
        action: 'plaft_subject.screened',
        entity: 'plaft_subject',
        entityId: inserted.id,
        data: {
          relation: subject.relation,
          doc_type: subject.doc_type,
          doc_number: subject.doc_number,
          regime: subject.regime,
          risk_factors: subject.risk_factors,
          matches: out.matches,
          case_id: out.case_id,
          adverse_media: { provider: media.provider, articles: media.articles.length, relevant: media.relevant },
        },
      });
      return {
        subject,
        screening: { id: out.screening_id, matches: res.matches, adverse_media: media },
        case_id: out.case_id,
      };
    });
  }

  async list(tenant: Tenant, q: ListSubjectsQuery) {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    return this.db.withTenant(tenant.id, async (db) => {
      const where = `($1::text IS NULL OR relation = $1) AND ($2::text IS NULL OR regime = $2)
        AND ($3::boolean IS NULL OR monitor = $3)
        AND ($4::text IS NULL OR name ILIKE '%' || $4 || '%' OR doc_number = upper($4))
        AND ($5::int IS NULL OR next_review_at <= now() + make_interval(days => $5))`;
      const params = [q.relation ?? null, q.regime ?? null, q.monitor ?? null, q.q ?? null, q.due_within_days ?? null];
      const total = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM plaft_subjects WHERE ${where}`, params);
      const items = await many(
        db,
        `SELECT ${SUBJECT_COLUMNS},
                (SELECT count(*)::int FROM plaft_cases c WHERE c.subject_id = s.id AND c.status = 'abierto') AS open_cases
           FROM plaft_subjects s WHERE ${where} ORDER BY created_at DESC, id LIMIT $6 OFFSET $7`,
        [...params, limit, offset],
      );
      return { items, total: total!.n, limit, offset };
    });
  }

  async get(tenant: Tenant, id: string) {
    return this.db.withTenant(tenant.id, async (db) => {
      const subject = await one(db, `SELECT ${SUBJECT_COLUMNS} FROM plaft_subjects WHERE id = $1`, [id]);
      if (!subject) throw new NotFoundException('Sujeto no encontrado');
      const screenings = await many(
        db,
        `SELECT id, kind, threshold, query_normalized, matches, new_matches, adverse_media, created_at
           FROM plaft_screenings WHERE subject_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [id],
      );
      const matches = await many(
        db,
        `SELECT id, case_id, source, category, entry_id, matched_name, score, status, created_at
           FROM plaft_matches WHERE subject_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      const cases = await many(
        db,
        `SELECT id, status, origin, decision, decided_at, ros_draft, created_at FROM plaft_cases
          WHERE subject_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      return { ...subject, screenings, matches, cases };
    });
  }

  /** Carga masiva en CSV: valida, guarda o actualiza y revisa por lotes de 500 con /v1/screen/batch. */
  async bulk(tenant: Tenant, file: Buffer | undefined, defaultMonitor: boolean, actor: string) {
    if (!file?.length) throw new BadRequestException('Adjunte el CSV en el campo "file"');
    let parsed: ReturnType<typeof parseSubjectsCsv>;
    try {
      parsed = parseSubjectsCsv(file.toString('utf8'));
    } catch (err) {
      if (err instanceof CsvHeaderError) throw new BadRequestException(err.message);
      throw err;
    }
    const errors = [...parsed.errors];
    const valid: CsvSubject[] = [];
    const rucCache = new Map<string, boolean>();
    for (const s of parsed.subjects) {
      if (s.doc_type === 'RUC') {
        if (!rucCache.has(s.doc_number)) rucCache.set(s.doc_number, (await this.engine.validateRuc(s.doc_number)).valid);
        if (!rucCache.get(s.doc_number)) {
          errors.push({ line: s.line, message: `El RUC ${s.doc_number} no es válido (dígito de control)` });
          continue;
        }
      }
      valid.push(s);
    }

    const threshold = plaftSettings(tenant.settings).threshold;
    const summary = { received: parsed.subjects.length + parsed.errors.length, created: 0, updated: 0, screened: 0, with_matches: 0, cases_opened: 0 };
    for (let i = 0; i < valid.length; i += BATCH_SIZE) {
      const chunk = valid.slice(i, i + BATCH_SIZE);
      const res = await this.engine.screenBatch({
        threshold,
        subjects: chunk.map((s) => ({
          ref: String(s.line),
          name: s.name,
          kind: s.kind,
          ...(s.birth_date ? { birth_date: s.birth_date } : {}),
          ...(s.nationality ? { nationality: s.nationality } : {}),
        })),
      });
      const byRef = new Map(res.results.map((r) => [r.ref, r.matches]));
      await this.db.withTenant(tenant.id, async (db) => {
        for (const s of chunk) {
          const row = await this.upsert(db, tenant, s, defaultMonitor);
          if (row.inserted) summary.created++;
          else summary.updated++;
          const matches = byRef.get(String(s.line)) ?? [];
          const out = await this.screening.applyResult(db, tenant, row, { kind: 'bulk', threshold, matches }, actor);
          await this.screening.refreshRegime(db, tenant, row.id);
          await this.usage.record(db, tenant.id, 'plaft', 'onboarding_check', 1, row.id);
          summary.screened++;
          if (out.matches) summary.with_matches++;
          if (out.case_id) summary.cases_opened++;
        }
      });
    }
    await this.db.withTenant(tenant.id, (db) =>
      this.audit.record(db, tenant.id, {
        actor,
        action: 'plaft_subject.bulk_loaded',
        entity: 'plaft_portfolio',
        data: { ...summary, errors: errors.length },
      }),
    );
    return { ...summary, errors: errors.sort((a, b) => a.line - b.line) };
  }

  private async upsert(db: Queryable, tenant: Tenant, s: CsvSubject, defaultMonitor: boolean) {
    return (await one<SubjectRow & { inserted: boolean }>(
      db,
      `INSERT INTO plaft_subjects (tenant_id, relation, kind, name, doc_type, doc_number, birth_date, nationality, monitor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, relation, doc_type, doc_number) DO UPDATE SET
         name = EXCLUDED.name, kind = EXCLUDED.kind,
         birth_date = COALESCE(EXCLUDED.birth_date, plaft_subjects.birth_date),
         nationality = COALESCE(EXCLUDED.nationality, plaft_subjects.nationality),
         monitor = EXCLUDED.monitor, updated_at = now()
       RETURNING id, name, (xmax = 0) AS inserted`,
      [tenant.id, s.relation, s.kind, s.name, s.doc_type, s.doc_number, s.birth_date, s.nationality, s.monitor ?? defaultMonitor],
    ))!;
  }

  /** Resumen para el oficial de cumplimiento. */
  async report(tenant: Tenant, q: ReportQuery) {
    const now = new Date();
    const from = q.from ? new Date(q.from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = q.to ? new Date(q.to) : now;
    if (from > to) throw new BadRequestException('from debe ser anterior a to');
    return this.db.withTenant(tenant.id, async (db) => {
      const count = async (sql: string, params: unknown[] = []) =>
        Object.fromEntries((await many<{ k: string; n: number }>(db, sql, params)).map((r) => [r.k, r.n]));
      const portfolio = {
        total: (await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM plaft_subjects'))!.n,
        monitored: (await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM plaft_subjects WHERE monitor'))!.n,
        by_relation: await count('SELECT relation AS k, count(*)::int AS n FROM plaft_subjects GROUP BY 1'),
        by_regime: await count('SELECT regime AS k, count(*)::int AS n FROM plaft_subjects GROUP BY 1'),
      };
      const range = [from, to];
      const period = {
        new_subjects_by_relation: await count(
          'SELECT relation AS k, count(*)::int AS n FROM plaft_subjects WHERE created_at >= $1 AND created_at <= $2 GROUP BY 1',
          range,
        ),
        screenings_by_kind: await count(
          'SELECT kind AS k, count(*)::int AS n FROM plaft_screenings WHERE created_at >= $1 AND created_at <= $2 GROUP BY 1',
          range,
        ),
        matches_by_category: await count(
          'SELECT category AS k, count(*)::int AS n FROM plaft_matches WHERE created_at >= $1 AND created_at <= $2 GROUP BY 1',
          range,
        ),
        cases_opened: (await one<{ n: number }>(
          db,
          'SELECT count(*)::int AS n FROM plaft_cases WHERE created_at >= $1 AND created_at <= $2',
          range,
        ))!.n,
        decisions: await count(
          'SELECT decision AS k, count(*)::int AS n FROM plaft_cases WHERE decided_at >= $1 AND decided_at <= $2 GROUP BY 1',
          range,
        ),
        ros_drafts: (await one<{ n: number }>(
          db,
          'SELECT count(*)::int AS n FROM plaft_cases WHERE ros_draft AND decided_at >= $1 AND decided_at <= $2',
          range,
        ))!.n,
      };
      const open_cases = (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM plaft_cases WHERE status = 'abierto'`))!.n;
      const due = await many(
        db,
        `SELECT id, name, relation, regime, next_review_at FROM plaft_subjects
          WHERE next_review_at <= now() + interval '30 days' ORDER BY next_review_at LIMIT 100`,
      );
      const overdue = (await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM plaft_subjects WHERE next_review_at < now()'))!.n;
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        portfolio,
        period,
        open_cases,
        reviews_due_30_days: { count: due.length, overdue, subjects: due },
      };
    });
  }
}
