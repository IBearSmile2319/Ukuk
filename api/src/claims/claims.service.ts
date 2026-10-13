import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable, many, one } from '../db/db.service';
import { Finding } from '../engine/engine.types';
import { BlobsService } from '../storage/blobs.service';
import { Tenant } from '../tenancy/tenant';
import { UsageService } from '../usage/usage.service';
import { ClaimsConfig, DestinationConfig, PolicySourceConfig, mergeConfig, publicConfig } from './claim-config';
import { ConversationData, PolicySnapshot } from './conversation';
import { Deadlines, InsuranceLine, computeDeadlines, limaDate } from './deadlines';
import { ClaimDispatcher } from './destination';
import { ClaimsConfigDto, ClaimsQueryDto, DecisionDto, ReviewDto } from './dto';
import { parsePolicyCsv } from './policy-provider';
import { assessRisk } from './risk';
import { WaMessenger } from './wa-messenger.service';

const OPEN_STATUSES = ['revision_analista', 'ajustador', 'aclaracion'];

export interface ClaimRow {
  id: string;
  number: string;
  status: string;
  conversation_id: string | null;
  wa_id: string | null;
  policy_number: string | null;
  holder_name: string | null;
  holder_dni: string | null;
  claim_type: string | null;
  line: InsuranceLine | null;
  policy: Partial<PolicySnapshot>;
  occurred_at: Date | null;
  first_contact_at: Date;
  location: Record<string, unknown> | null;
  narrative: string | null;
  missing_docs: string[];
  docs_complete_at: Date | null;
  late_notice: boolean;
  risk_level: string;
  risk_score: number;
  risk_reasons: string[];
  requires_analyst_review: boolean;
  decision: 'aprobado' | 'rechazado' | null;
  decided_at: Date | null;
  [k: string]: unknown;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function deadlinesOf(c: ClaimRow, now = new Date()): Deadlines {
  return computeDeadlines({
    line: c.line ?? 'daños',
    occurredAt: c.occurred_at,
    firstContactAt: c.first_contact_at,
    policyNoticeDays: c.policy?.notice_days ?? null,
    docsCompleteAt: c.docs_complete_at,
    decision: c.decision,
    decidedAt: c.decided_at,
    now,
  });
}

export function serializeDeadlines(d: Deadlines) {
  return {
    notice_days: d.noticeDays,
    notice_deadline: iso(d.noticeDeadline),
    late_notice: d.lateNotice,
    docs_complete_at: iso(d.clockStart),
    day_count: d.dayCount,
    clarification_cutoff: iso(d.clarificationCutoff),
    consent_deadline: iso(d.consentDeadline),
    payment_deadline: iso(d.paymentDeadline),
    can_request_clarification: d.canRequestClarification,
    consented: d.consented,
    alerts: d.alerts.map((a) => ({ kind: a.kind, due_at: a.dueAt.toISOString(), message: a.message })),
  };
}

/** ¿La ocurrencia cae fuera de la vigencia de la póliza (o la póliza no está vigente)? */
export function outsideCoverage(policy: Partial<PolicySnapshot>, occurredAt: Date | null): boolean {
  if (!policy?.policy_number) return true;
  if (policy.status && !/^(vigente|activa|active)$/i.test(policy.status)) return true;
  if (!occurredAt) return false;
  const day = limaDate(occurredAt);
  return (!!policy.start_date && day < policy.start_date) || (!!policy.end_date && day > policy.end_date);
}

@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly blobs: BlobsService,
    private readonly dispatcher: ClaimDispatcher,
    private readonly messenger: WaMessenger,
  ) {}

  // ---- Configuración y pólizas ----

  async config(db: Queryable): Promise<ClaimsConfig> {
    const row = await one(db, 'SELECT config FROM claim_settings');
    return mergeConfig(row?.config);
  }

  async getConfig(tenant: Tenant) {
    return publicConfig(await this.db.withTenant(tenant.id, (db) => this.config(db)));
  }

  async putConfig(tenant: Tenant, dto: ClaimsConfigDto, actor: string) {
    if (dto.destination?.type === 'webhook' && (!dto.destination.url || !dto.destination.secret)) {
      throw new BadRequestException('El destino webhook necesita url y secret (mínimo 16 caracteres)');
    }
    if (dto.destination?.type === 'email' && !dto.destination.to?.length) throw new BadRequestException('El destino email necesita "to"');
    if (dto.policy_source?.type === 'http' && !dto.policy_source.url) throw new BadRequestException('La fuente http necesita url');
    if (dto.policy_source?.type === 'http' && process.env.NODE_ENV === 'production' && !dto.policy_source.url!.startsWith('https://')) {
      throw new BadRequestException('La API de pólizas debe usar https');
    }
    return this.db.withTenant(tenant.id, async (db) => {
      const current = await this.config(db);
      const next: ClaimsConfig = {
        ...current,
        ...dto,
        claim_types: dto.claim_types ?? current.claim_types,
        destination: (dto.destination as DestinationConfig | undefined) ?? current.destination,
        policy_source: (dto.policy_source as PolicySourceConfig | undefined) ?? current.policy_source,
      };
      await db.query(
        `INSERT INTO claim_settings (tenant_id, config) VALUES ($1,$2)
         ON CONFLICT (tenant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
        [tenant.id, next],
      );
      await this.audit.record(db, tenant.id, {
        actor,
        action: 'claims.config_updated',
        entity: 'claim_settings',
        data: { changed: Object.keys(dto), config: publicConfig(next) as unknown as Record<string, unknown> },
      });
      return publicConfig(next);
    });
  }

  async importPolicies(tenant: Tenant, csv: string, replace: boolean, actor: string) {
    const { rows, errors } = parsePolicyCsv(csv);
    if (!rows.length && !errors.length) throw new BadRequestException('El CSV no tiene filas');
    return this.db.withTenant(tenant.id, async (db) => {
      for (const r of rows) {
        await db.query(
          `INSERT INTO claim_policies (tenant_id, policy_number, holder_dni, holder_name, plate, product, line, start_date, end_date, notice_days, status, imported_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
           ON CONFLICT (tenant_id, policy_number) DO UPDATE SET holder_dni = EXCLUDED.holder_dni, holder_name = EXCLUDED.holder_name,
             plate = EXCLUDED.plate, product = EXCLUDED.product, line = EXCLUDED.line, start_date = EXCLUDED.start_date,
             end_date = EXCLUDED.end_date, notice_days = EXCLUDED.notice_days, status = EXCLUDED.status, imported_at = now()`,
          [tenant.id, r.policy_number, r.holder_dni, r.holder_name, r.plate, r.product, r.line, r.start_date, r.end_date, r.notice_days, r.status],
        );
      }
      let retired = 0;
      if (replace && rows.length) {
        const res = await db.query(
          `UPDATE claim_policies SET status = 'no_vigente' WHERE NOT (policy_number = ANY($1)) AND status <> 'no_vigente'`,
          [rows.map((r) => r.policy_number)],
        );
        retired = res.rowCount ?? 0;
      }
      await this.audit.record(db, tenant.id, {
        actor,
        action: 'claims.policies_imported',
        entity: 'claim_policies',
        data: { imported: rows.length, errors: errors.length, retired, replace },
      });
      return { imported: rows.length, retired, errors };
    });
  }

  // ---- Ciclo de vida del caso ----

  /** Crea el borrador del caso (lo necesita el enlace de captura). Idempotente por conversación. */
  async ensureDraft(db: Queryable, tenant: Tenant, conv: { id: string; wa_id: string; first_message_at: Date; claim_id: string | null }, data: ConversationData): Promise<string> {
    if (conv.claim_id) {
      await this.syncDraft(db, conv.claim_id, data);
      return conv.claim_id;
    }
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`claimnum:${tenant.id}`]);
    const seq = await one<{ n: number }>(db, 'SELECT count(*)::int + 1 AS n FROM claims');
    const number = `SIN-${limaDate(new Date()).slice(0, 4)}-${String(seq!.n).padStart(6, '0')}`;
    const row = await one<{ id: string }>(
      db,
      `INSERT INTO claims (tenant_id, number, conversation_id, wa_id, first_contact_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tenant.id, number, conv.id, conv.wa_id, conv.first_message_at],
    );
    await db.query('UPDATE claim_conversations SET claim_id = $2 WHERE id = $1', [conv.id, row!.id]);
    await db.query('UPDATE claim_files SET claim_id = $2 WHERE conversation_id = $1 AND claim_id IS NULL', [conv.id, row!.id]);
    conv.claim_id = row!.id;
    await this.syncDraft(db, row!.id, data);
    return row!.id;
  }

  private async syncDraft(db: Queryable, claimId: string, d: ConversationData) {
    await db.query(
      `UPDATE claims SET policy_number = $2, holder_name = $3, holder_dni = $4, claim_type = $5, line = $6, policy = $7,
         occurred_at = $8, location = $9, narrative = $10, updated_at = now()
       WHERE id = $1`,
      [
        claimId,
        d.policy?.policy_number ?? null,
        d.policy?.holder_name ?? null,
        d.policy?.holder_dni ?? null,
        d.claimType ?? null,
        d.policy?.line ?? null,
        d.policy ?? {},
        d.occurredAt ?? null,
        d.location ?? null,
        d.narrative ?? null,
      ],
    );
  }

  /**
   * El cliente confirmó: el caso entra al flujo. Si es de riesgo alto va primero al
   * analista; si no, directo al ajustador (y se envía al destino configurado).
   */
  async submit(db: Queryable, tenant: Tenant, claimId: string, d: ConversationData, now = new Date()) {
    await this.syncDraft(db, claimId, d);
    const docsComplete = d.pendingDocs.length === 0;
    await db.query(
      `UPDATE claims SET missing_docs = $2, docs_complete_at = $3, submitted_at = $4 WHERE id = $1`,
      [claimId, d.pendingDocs, docsComplete ? now : null, now],
    );
    const claim = await this.refreshRisk(db, claimId, now);
    const status = claim.requires_analyst_review ? 'revision_analista' : 'ajustador';
    await db.query(`UPDATE claims SET status = $2, updated_at = now() WHERE id = $1`, [claimId, status]);
    await this.usage.record(db, tenant.id, 'claims', 'claim', 1, claimId);
    await this.audit.record(db, tenant.id, {
      actor: `whatsapp:${claim.wa_id}`,
      action: 'claim.created',
      entity: 'claim',
      entityId: claimId,
      data: { number: claim.number, status, risk: claim.risk_level, claim_type: claim.claim_type, docs_complete: docsComplete },
    });
    return { ...claim, status };
  }

  /** Recalcula riesgo y plazos guardados a partir de los archivos y datos del caso. */
  async refreshRisk(db: Queryable, claimId: string, now = new Date()): Promise<ClaimRow> {
    const claim = await one<ClaimRow>(db, 'SELECT * FROM claims WHERE id = $1', [claimId]);
    if (!claim) throw new NotFoundException('Siniestro no encontrado');
    const files = await many<{ findings: Finding[] }>(db, 'SELECT findings FROM claim_files WHERE claim_id = $1', [claimId]);
    const d = deadlinesOf(claim, now);
    const risk = assessRisk({
      findings: files.flatMap((f) => f.findings),
      lateNotice: d.lateNotice,
      outsideCoverage: outsideCoverage(claim.policy, claim.occurred_at),
    });
    const updated = await one<ClaimRow>(
      db,
      `UPDATE claims SET risk_level = $2, risk_score = $3, risk_reasons = $4, requires_analyst_review = $5,
         late_notice = $6, notice_deadline = $7, clarification_cutoff = $8, consent_deadline = $9,
         payment_deadline = COALESCE(payment_deadline, $10), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [claimId, risk.level, risk.score, JSON.stringify(risk.reasons), risk.requiresAnalystReview, d.lateNotice, d.noticeDeadline, d.clarificationCutoff, d.consentDeadline, d.paymentDeadline],
    );
    return updated!;
  }

  /** Envía el caso al sistema del cliente después del COMMIT. */
  async dispatch(tenant: Tenant, claimId: string) {
    const { config, claim } = await this.db.withTenant(tenant.id, async (db) => ({
      config: await this.config(db),
      claim: await one<ClaimRow>(db, 'SELECT * FROM claims WHERE id = $1', [claimId]),
    }));
    if (!claim || config.destination.type === 'none') return;
    const res = await this.dispatcher.dispatch(config.destination, {
      id: claim.id,
      number: claim.number,
      status: claim.status,
      policy_number: claim.policy_number,
      holder_name: claim.holder_name,
      holder_dni: claim.holder_dni,
      claim_type: claim.claim_type,
      occurred_at: iso(claim.occurred_at),
      location: claim.location,
      narrative: claim.narrative,
      risk: { level: claim.risk_level, score: claim.risk_score, reasons: claim.risk_reasons },
      deadlines: serializeDeadlines(deadlinesOf(claim)),
    });
    await this.db.withTenant(tenant.id, async (db) => {
      if (res.ok) await db.query('UPDATE claims SET dispatched_at = now() WHERE id = $1', [claimId]);
      await this.audit.record(db, tenant.id, {
        actor: 'system',
        action: res.ok ? 'claim.dispatched' : 'claim.dispatch_failed',
        entity: 'claim',
        entityId: claimId,
        data: { ...res },
      });
    });
  }

  // ---- Consulta ----

  list(tenant: Tenant, q: ClaimsQueryDto) {
    return this.db.withTenant(tenant.id, (db) =>
      many(
        db,
        `SELECT id, number, status, policy_number, holder_name, claim_type, line, occurred_at, first_contact_at, risk_level,
                risk_score, requires_analyst_review, late_notice, docs_complete_at, clarification_cutoff, consent_deadline,
                payment_deadline, decision, created_at, updated_at
           FROM claims
          WHERE status <> 'borrador'
            AND ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR risk_level = $2)
            AND ($3::int IS NULL OR (status = ANY($4) AND consent_deadline <= now() + make_interval(days => $3)))
          ORDER BY consent_deadline NULLS LAST, created_at DESC
          LIMIT $5 OFFSET $6`,
        [q.status ?? null, q.risk ?? null, q.due_within_days ?? null, OPEN_STATUSES, q.limit ?? 50, q.offset ?? 0],
      ),
    );
  }

  async get(tenant: Tenant, id: string, now = new Date()) {
    return this.db.withTenant(tenant.id, async (db) => {
      const claim = await one<ClaimRow>(db, 'SELECT * FROM claims WHERE id = $1', [id]);
      if (!claim) throw new NotFoundException('Siniestro no encontrado');
      // Secuencial: una transacción usa una sola conexión.
      const messages = claim.conversation_id
        ? await many(db, `SELECT direction, type, body, file_id, at FROM claim_messages WHERE conversation_id = $1 ORDER BY id`, [claim.conversation_id])
        : [];
      const files = await many(
        db,
        `SELECT id, kind, source, doc_type, mime_type, sha256, findings, capture,
                analysis->'image'->'quality' AS quality, created_at
           FROM claim_files WHERE claim_id = $1 ORDER BY created_at`,
        [id],
      );
      const alerts = await many(db, 'SELECT kind, message, due_at, created_at FROM claim_alerts WHERE claim_id = $1 ORDER BY created_at', [id]);
      return {
        ...claim,
        deadlines: serializeDeadlines(deadlinesOf(claim, now)),
        transcript: messages,
        files,
        alerts,
      };
    });
  }

  async file(tenant: Tenant, claimId: string, fileId: string) {
    return this.db.withTenant(tenant.id, async (db) => {
      const f = await one(db, 'SELECT blob_id FROM claim_files WHERE id = $1 AND claim_id = $2', [fileId, claimId]);
      if (!f) throw new NotFoundException('Archivo no encontrado');
      return this.blobs.load(db, tenant, f.blob_id);
    });
  }

  // ---- Decisiones ----

  private async lockOpen(db: Queryable, id: string): Promise<ClaimRow> {
    const claim = await one<ClaimRow>(db, 'SELECT * FROM claims WHERE id = $1 FOR UPDATE', [id]);
    if (!claim || claim.status === 'borrador') throw new NotFoundException('Siniestro no encontrado');
    return claim;
  }

  private clarificationGuard(d: Deadlines) {
    if (d.consented) throw new ConflictException('El siniestro ya quedó consentido por vencimiento del plazo de 30 días; debe pagarse.');
    if (!d.canRequestClarification) {
      throw new UnprocessableEntityException({
        error: 'aclaracion_fuera_de_plazo',
        message:
          `Ya no se pueden pedir aclaraciones: pasaron ${d.dayCount} días desde la documentación completa y el límite es el día 20 ` +
          `(Res. SBS 3202-2013). Debe aprobar o rechazar antes de ${d.consentDeadline?.toISOString()}.`,
        day_count: d.dayCount,
        clarification_cutoff: iso(d.clarificationCutoff),
        consent_deadline: iso(d.consentDeadline),
      });
    }
  }

  async review(tenant: Tenant, id: string, dto: ReviewDto, actor: string, now = new Date()) {
    let notify: string | null = null;
    let dispatch = false;
    const result = await this.db.withTenant(tenant.id, async (db) => {
      const claim = await this.lockOpen(db, id);
      if (claim.status !== 'revision_analista') throw new ConflictException(`El siniestro está en "${claim.status}", no en revisión del analista`);
      const d = deadlinesOf(claim, now);
      let status: string;
      if (dto.action === 'approve_to_adjuster') {
        status = 'ajustador';
        dispatch = true;
      } else if (dto.action === 'reject') {
        if (!dto.note) throw new BadRequestException('El rechazo debe estar motivado (note)');
        if (d.consented) throw new ConflictException('El siniestro ya quedó consentido; no puede rechazarse.');
        status = 'rechazado';
        notify = `Su siniestro ${claim.number} fue rechazado. Motivo: ${dto.note}`;
      } else {
        this.clarificationGuard(d);
        if (!dto.note) throw new BadRequestException('Indique qué información falta (note)');
        status = 'aclaracion';
        notify = `Sobre su siniestro ${claim.number}, necesitamos: ${dto.note}. Puede responder por este chat.`;
      }
      const row = await one(
        db,
        `UPDATE claims SET status = $2, review_action = $3, review_note = $4,
           decision = CASE WHEN $2 = 'rechazado' THEN 'rechazado' ELSE decision END,
           decided_at = CASE WHEN $2 = 'rechazado' THEN $5::timestamptz ELSE decided_at END,
           clarification_requested_at = CASE WHEN $2 = 'aclaracion' THEN $5::timestamptz ELSE clarification_requested_at END,
           updated_at = now()
         WHERE id = $1 RETURNING id, number, status`,
        [id, status, dto.action, dto.note ?? null, now],
      );
      await this.audit.record(db, tenant.id, {
        actor,
        action: `claim.review.${dto.action}`,
        entity: 'claim',
        entityId: id,
        data: { from: claim.status, to: status, note: dto.note ?? null, day_count: d.dayCount },
      });
      return row;
    });
    if (dispatch) await this.dispatch(tenant, id);
    if (notify) await this.notifyClaimant(tenant, id, notify);
    return result;
  }

  async decide(tenant: Tenant, id: string, dto: DecisionDto, actor: string, now = new Date()) {
    let notify: string | null = null;
    const result = await this.db.withTenant(tenant.id, async (db) => {
      const claim = await this.lockOpen(db, id);
      if (claim.status === 'revision_analista') {
        throw new ConflictException('El caso es de riesgo alto: primero debe revisarlo un analista.');
      }
      if (!['ajustador', 'aclaracion', 'consentido'].includes(claim.status)) {
        throw new ConflictException(`El siniestro ya está "${claim.status}"`);
      }
      const d = deadlinesOf(claim, now);
      if (dto.decision === 'aclaracion') {
        this.clarificationGuard(d);
        if (!dto.note) throw new BadRequestException('Indique qué aclaración necesita (note)');
        notify = `Sobre su siniestro ${claim.number}, necesitamos una aclaración: ${dto.note}. Puede responder por este chat.`;
      } else if (dto.decision === 'rechazado') {
        if (d.consented || claim.status === 'consentido') {
          throw new ConflictException('El siniestro quedó consentido por vencimiento del plazo de 30 días; ya no puede rechazarse.');
        }
        if (!dto.note) throw new BadRequestException('El rechazo debe estar motivado (note)');
        notify = `Su siniestro ${claim.number} fue rechazado. Motivo: ${dto.note}`;
      } else {
        notify = `Su siniestro ${claim.number} fue aprobado. Le contactaremos para el pago.`;
      }
      const final = dto.decision !== 'aclaracion';
      const status = dto.decision;
      const row = await one<ClaimRow>(
        db,
        `UPDATE claims SET status = $2, decision = CASE WHEN $3 THEN $2 ELSE decision END, decision_note = $4,
           decided_at = CASE WHEN $3 THEN $5::timestamptz ELSE decided_at END,
           clarification_requested_at = CASE WHEN $2 = 'aclaracion' THEN $5::timestamptz ELSE clarification_requested_at END,
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, status, final, dto.note ?? null, now],
      );
      const after = deadlinesOf(row!, now);
      await db.query('UPDATE claims SET payment_deadline = $2 WHERE id = $1', [id, after.paymentDeadline]);
      await this.audit.record(db, tenant.id, {
        actor,
        action: `claim.decision.${dto.decision}`,
        entity: 'claim',
        entityId: id,
        data: { from: claim.status, to: status, note: dto.note ?? null, day_count: d.dayCount },
      });
      return { id, number: row!.number, status, deadlines: serializeDeadlines(after) };
    });
    if (notify) await this.notifyClaimant(tenant, id, notify);
    return result;
  }

  /** El asegurado completó los documentos pendientes: empieza a correr el plazo de 30 días. */
  async documentsComplete(tenant: Tenant, id: string, actor: string, now = new Date()) {
    return this.db.withTenant(tenant.id, async (db) => {
      const claim = await this.lockOpen(db, id);
      if (claim.docs_complete_at) throw new ConflictException('La documentación ya estaba completa');
      await db.query(`UPDATE claims SET docs_complete_at = $2, missing_docs = '{}', updated_at = now() WHERE id = $1`, [id, now]);
      const updated = await this.refreshRisk(db, id, now);
      await this.audit.record(db, tenant.id, { actor, action: 'claim.documents_complete', entity: 'claim', entityId: id, data: { missing_before: claim.missing_docs } });
      return { id, deadlines: serializeDeadlines(deadlinesOf(updated, now)) };
    });
  }

  /** Mensaje al asegurado. TODO: fuera de la ventana de 24 h, Meta exige plantillas aprobadas. */
  async notifyClaimant(tenant: Tenant, claimId: string, text: string) {
    try {
      const target = await this.db.withTenant(tenant.id, async (db) => {
        const c = await one(
          db,
          `SELECT c.id AS claim_id, v.id AS conversation_id, v.wa_id, v.phone_number_id
             FROM claims c JOIN claim_conversations v ON v.id = c.conversation_id WHERE c.id = $1`,
          [claimId],
        );
        if (!c) return null;
        const outs = [{ type: 'text' as const, text }];
        const ids = await this.messenger.record(db, tenant, c.conversation_id, outs, claimId);
        return { ...c, outs, ids };
      });
      if (!target) return;
      const n = await this.messenger.number(target.phone_number_id);
      if (!n) return;
      await this.messenger.deliver(tenant, this.messenger.sender(tenant, n), target.wa_id, target.outs, target.ids);
    } catch (err) {
      this.logger.error(`No se pudo notificar al asegurado del siniestro ${claimId}: ${(err as Error).message}`);
    }
  }

  // ---- Reloj legal ----

  /** Registra alertas alcanzadas y marca como consentidos los casos vencidos. */
  async sweepTenant(tenant: Tenant, now = new Date()) {
    return this.db.withTenant(tenant.id, async (db) => {
      const claims = await many<ClaimRow>(
        db,
        `SELECT * FROM claims WHERE status = ANY($1) AND docs_complete_at IS NOT NULL FOR UPDATE`,
        [OPEN_STATUSES],
      );
      let alerts = 0;
      let consented = 0;
      for (const c of claims) {
        const d = deadlinesOf(c, now);
        for (const a of d.alerts) {
          const r = await db.query(
            `INSERT INTO claim_alerts (tenant_id, claim_id, kind, message, due_at) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (tenant_id, claim_id, kind) DO NOTHING`,
            [tenant.id, c.id, a.kind, a.message, a.dueAt],
          );
          alerts += r.rowCount ?? 0;
        }
        if (d.consented) {
          consented++;
          await db.query(
            `UPDATE claims SET status = 'consentido', consented_at = $2, payment_deadline = $3, updated_at = now() WHERE id = $1`,
            [c.id, d.consentDeadline, d.paymentDeadline],
          );
          await this.audit.record(db, tenant.id, {
            actor: 'system',
            action: 'claim.consented',
            entity: 'claim',
            entityId: c.id,
            data: { from: c.status, consent_deadline: iso(d.consentDeadline), payment_deadline: iso(d.paymentDeadline) },
          });
        } else {
          await db.query('UPDATE claims SET clarification_cutoff = $2, consent_deadline = $3 WHERE id = $1', [c.id, d.clarificationCutoff, d.consentDeadline]);
        }
      }
      return { checked: claims.length, alerts, consented };
    });
  }

  async alerts(tenant: Tenant) {
    await this.sweepTenant(tenant);
    return this.db.withTenant(tenant.id, (db) =>
      many(
        db,
        `SELECT a.kind, a.message, a.due_at, a.created_at, c.id AS claim_id, c.number, c.status, c.consent_deadline
           FROM claim_alerts a JOIN claims c ON c.id = a.claim_id
          ORDER BY a.created_at DESC LIMIT 500`,
      ),
    );
  }
}
