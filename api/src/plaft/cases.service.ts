import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService, many, one } from '../db/db.service';
import { Tenant } from '../tenancy/tenant';
import { DecisionDto, ListCasesQuery } from './dto';
import { ScreeningService } from './screening.service';

const MATCH_STATUS: Record<DecisionDto['decision'], string> = {
  falso_positivo: 'descartada',
  coincidencia_confirmada: 'confirmada',
  escalado_uif: 'confirmada',
};

/** Casos para el oficial de cumplimiento: decisión con sustento y línea de tiempo inalterable. */
@Injectable()
export class CasesService {
  constructor(
    private readonly db: DbService,
    private readonly screening: ScreeningService,
  ) {}

  list(tenant: Tenant, q: ListCasesQuery) {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    return this.db.withTenant(tenant.id, async (db) => {
      const total = await one<{ n: number }>(
        db,
        'SELECT count(*)::int AS n FROM plaft_cases WHERE ($1::text IS NULL OR status = $1)',
        [q.status ?? null],
      );
      const items = await many(
        db,
        `SELECT c.id, c.status, c.origin, c.decision, c.decided_at, c.ros_draft, c.created_at,
                s.id AS subject_id, s.name AS subject_name, s.relation, s.doc_type, s.doc_number,
                (SELECT count(*)::int FROM plaft_matches m WHERE m.case_id = c.id) AS matches,
                (SELECT max(m.score) FROM plaft_matches m WHERE m.case_id = c.id) AS top_score
           FROM plaft_cases c JOIN plaft_subjects s ON s.id = c.subject_id
          WHERE ($1::text IS NULL OR c.status = $1)
          ORDER BY c.created_at DESC, c.id LIMIT $2 OFFSET $3`,
        [q.status ?? null, limit, offset],
      );
      return { items, total: total!.n, limit, offset };
    });
  }

  get(tenant: Tenant, id: string) {
    return this.db.withTenant(tenant.id, async (db) => {
      const c = await one(db, 'SELECT * FROM plaft_cases WHERE id = $1', [id]);
      if (!c) throw new NotFoundException('Caso no encontrado');
      const subject = await one(
        db,
        `SELECT id, relation, kind, name, doc_type, doc_number, birth_date::text AS birth_date, nationality, regime, risk_factors
           FROM plaft_subjects WHERE id = $1`,
        [c.subject_id],
      );
      const matches = await many(
        db,
        `SELECT id, source, category, entry_id, matched_name, score, status, data, created_at
           FROM plaft_matches WHERE case_id = $1 ORDER BY score DESC`,
        [id],
      );
      const timeline = await many(
        db,
        'SELECT id, at, actor, type, data FROM plaft_case_events WHERE case_id = $1 ORDER BY id',
        [id],
      );
      const { tenant_id, ...rest } = c;
      return { ...rest, subject, matches, timeline };
    });
  }

  async decide(tenant: Tenant, id: string, dto: DecisionDto, actor: string) {
    await this.db.withTenant(tenant.id, async (db) => {
      const c = await one(db, 'SELECT id, status, subject_id FROM plaft_cases WHERE id = $1 FOR UPDATE', [id]);
      if (!c) throw new NotFoundException('Caso no encontrado');
      if (c.status !== 'abierto') throw new ConflictException('El caso ya está cerrado');
      const rationale = dto.rationale.trim();
      if (rationale.length < 20) throw new BadRequestException('El sustento debe tener al menos 20 caracteres');
      const ros = dto.decision === 'escalado_uif';
      await db.query(
        `UPDATE plaft_cases SET status = 'cerrado', decision = $2, rationale = $3, decided_by = $4, decided_at = now(), ros_draft = $5
          WHERE id = $1`,
        [id, dto.decision, rationale, actor, ros],
      );
      await db.query('UPDATE plaft_matches SET status = $2 WHERE case_id = $1', [id, MATCH_STATUS[dto.decision]]);
      const subject = await this.screening.refreshRegime(db, tenant, c.subject_id);
      await this.screening.caseEvent(db, tenant.id, id, actor, 'decided', {
        decision: dto.decision,
        rationale,
        ros_draft: ros,
        subject_regime: subject.regime,
      });
    });
    return this.get(tenant, id);
  }
}
