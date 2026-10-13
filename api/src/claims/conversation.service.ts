import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService, Queryable, one } from '../db/db.service';
import { Tenant } from '../tenancy/tenant';
import { TenantsService } from '../tenancy/tenants.service';
import { UsageService } from '../usage/usage.service';
import { signCaptureToken } from './capture-token';
import { ClaimsConfig } from './claim-config';
import { ClaimFilesService, FileKind } from './claim-files.service';
import { ClaimsService } from './claims.service';
import {
  CLAIM_NUMBER_TOKEN,
  ConversationState,
  Inbound,
  Outbound,
  PolicySnapshot,
  initialState,
  parseIdentifier,
  step,
} from './conversation';
import { TRANSCRIBER, Transcriber } from './destination';
import { CsvPolicyProvider, policyProviderFor } from './policy-provider';
import { ResolvedOut, WaMessenger, WaNumberRow } from './wa-messenger.service';
import { MEDIA_LIMITS, WHATSAPP_CLIENT, WhatsAppClient } from './whatsapp.client';
import { WaInboundMessage, parseWebhookPayload } from './whatsapp-payload';

interface ConversationRow {
  id: string;
  wa_id: string;
  phone_number_id: string;
  state: ConversationState;
  status: 'active' | 'handoff' | 'closed';
  claim_id: string | null;
  message_count: number;
  first_message_at: Date;
}

/** Una conversación sin mensajes por 24 h se da por terminada (coincide con la ventana de atención de Meta). */
const CONVERSATION_WINDOW_HOURS = 24;

/**
 * Procesa los mensajes del webhook: deduplica, descarga los archivos al instante,
 * avanza la máquina de estados y envía las respuestas después del COMMIT.
 * Los mensajes de un mismo remitente se procesan en orden.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WHATSAPP_CLIENT) private readonly wa: WhatsAppClient,
    @Inject(TRANSCRIBER) private readonly transcriber: Transcriber,
    private readonly db: DbService,
    private readonly tenants: TenantsService,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly files: ClaimFilesService,
    private readonly claims: ClaimsService,
    private readonly messenger: WaMessenger,
    private readonly csvPolicies: CsvPolicyProvider,
  ) {}

  /** Encola sin esperar: el webhook responde 200 de inmediato. */
  enqueue(payload: unknown): number {
    const messages = parseWebhookPayload(payload);
    for (const m of messages) {
      const key = `${m.phoneNumberId}:${m.from}`;
      const prev = this.queues.get(key) ?? Promise.resolve();
      const job = prev
        .then(() => this.handle(m))
        .catch((err) => this.logger.error(`Mensaje ${m.wamid}: ${(err as Error).stack ?? err}`));
      this.queues.set(key, job);
      this.pending.add(job);
      void job.finally(() => {
        this.pending.delete(job);
        if (this.queues.get(key) === job) this.queues.delete(key);
      });
    }
    return messages.length;
  }

  /** Espera a que termine todo lo encolado (pruebas y apagado ordenado). */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  async handle(m: WaInboundMessage): Promise<void> {
    const number = await this.messenger.number(m.phoneNumberId);
    if (!number?.active) {
      this.logger.warn(`Mensaje para un número no registrado: ${m.phoneNumberId}`);
      return;
    }
    const tenant = await this.tenants.get(number.tenant_id).catch(() => undefined);
    if (!tenant || !tenant.modules.includes('claims')) return;
    const from = this.messenger.sender(tenant, number);

    const seen = await this.db.withTenant(tenant.id, (db) => one(db, 'SELECT 1 FROM wa_message_ids WHERE wamid = $1', [m.wamid]));
    if (seen) return;

    // La URL del archivo vence a los 5 minutos: se descarga antes que nada.
    let media: { data: Buffer; mimeType: string } | null = null;
    let mediaError: string | null = null;
    if (m.media) {
      try {
        media = await this.wa.downloadMedia(from, m.media.id);
        if (media.data.length > (MEDIA_LIMITS[m.media.kind] ?? MEDIA_LIMITS.document)) {
          media = null;
          mediaError = 'demasiado_grande';
        }
      } catch (err) {
        mediaError = (err as Error).message;
        this.logger.error(`Descarga de ${m.media.id} falló: ${mediaError}`);
      }
    }

    const result = await this.db.withTenant(tenant.id, (db) => this.process(db, tenant, number, m, media, mediaError));
    if (!result) return;
    await this.messenger.deliver(tenant, from, m.from, result.outs, result.ids);
    if (result.dispatchClaimId) await this.claims.dispatch(tenant, result.dispatchClaimId);
  }

  private async process(
    db: Queryable,
    tenant: Tenant,
    number: WaNumberRow,
    m: WaInboundMessage,
    media: { data: Buffer; mimeType: string } | null,
    mediaError: string | null,
  ): Promise<{ outs: ResolvedOut[]; ids: number[]; dispatchClaimId: string | null } | null> {
    const fresh = await db.query('INSERT INTO wa_message_ids (wamid, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [m.wamid, tenant.id]);
    if (!fresh.rowCount) return null;
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wa:${tenant.id}:${m.from}`]);
    const config = await this.claims.config(db);
    const conv = await this.conversation(db, tenant, number, m);
    const now = new Date();

    // Archivo entrante: se guarda cifrado y se analiza según el paso en que está la conversación.
    let input: Inbound = m.input;
    let fileId: string | null = null;
    if (m.media && media) {
      const stepNow = conv.state.step;
      const type = config.claim_types.find((t) => t.code === conv.state.data.claimType);
      const doc = stepNow === 'documentos' ? type?.required_docs[conv.state.data.docIndex] : undefined;
      const kind: FileKind = doc ? 'document' : m.media.kind === 'image' ? 'photo' : m.media.kind;
      const stored = await this.files.store(db, tenant, {
        data: media.data,
        mimeType: media.mimeType || m.media.mimeType,
        kind,
        source: 'whatsapp',
        claimId: conv.claim_id,
        conversationId: conv.id,
        docType: doc?.code ?? null,
        engineType: doc?.engine_type,
        filename: m.media.filename,
        extraFindings:
          kind === 'photo'
            ? [{ code: 'foto_sin_metadatos', layer: 'external', severity: 'low', confidence: 1, message: 'Foto enviada por WhatsApp: sin GPS ni hora de captura.' }]
            : [],
      });
      fileId = stored.id;
      input = { kind: 'media', media: m.media.kind, fileId, mimeType: media.mimeType, caption: m.media.caption };
      if (m.media.kind === 'audio') {
        const transcript = await this.transcriber.transcribe(media.data, media.mimeType).catch(() => null);
        if (transcript) await db.query(`UPDATE claim_files SET analysis = jsonb_build_object('transcript', $2::text) WHERE id = $1`, [fileId, transcript]);
      }
    }

    await db.query(
      `INSERT INTO claim_messages (tenant_id, conversation_id, direction, wamid, type, body, payload, file_id, at)
       VALUES ($1,$2,'in',$3,$4,$5,$6,$7,$8)`,
      [tenant.id, conv.id, m.wamid, m.type, m.body, { input: m.input, media: m.media ?? null, media_error: mediaError }, fileId, m.timestamp],
    );
    await this.usage.record(db, tenant.id, 'claims', 'whatsapp_message', 1, conv.claim_id ?? conv.id);
    await db.query('UPDATE claim_conversations SET message_count = message_count + 1, last_message_at = now() WHERE id = $1', [conv.id]);

    // Con un asesor a cargo el bot no responde: solo queda la transcripción.
    if (conv.status === 'handoff') return null;

    let outs: Outbound[];
    let next: ConversationState;
    let effects: ReturnType<typeof step>['effects'];
    if (m.media && !media) {
      next = conv.state;
      effects = [];
      outs = [{ type: 'text', text: mediaError === 'demasiado_grande' ? 'El archivo supera el tamaño permitido. Envíe uno más liviano.' : 'No pudimos recibir el archivo. Inténtelo de nuevo.' }];
    } else if (conv.message_count + 1 > config.max_inbound_messages * 2) {
      next = { ...conv.state, step: 'asesor' };
      effects = [{ type: 'handoff', reason: 'conversacion_larga' }];
      outs = [{ type: 'text', text: 'Un asesor continuará con su caso por este chat.' }];
    } else {
      const lookup = await this.lookupIfNeeded(db, conv.state, input, config);
      const photosCount = await this.photosCount(db, conv);
      const r = step(conv.state, input, { now, tenantName: tenant.name, claimTypes: config.claim_types, lookup, photosCount });
      next = r.state;
      outs = r.out;
      effects = r.effects;
    }

    let dispatchClaimId: string | null = null;
    let claimNumber: string | null = null;
    let status: ConversationRow['status'] = conv.status;
    for (const e of effects) {
      if (e.type === 'ensure_draft') {
        await this.claims.ensureDraft(db, tenant, conv, next.data);
      } else if (e.type === 'submit') {
        const claimId = await this.claims.ensureDraft(db, tenant, conv, next.data);
        const claim = await this.claims.submit(db, tenant, claimId, next.data, now);
        claimNumber = claim.number;
        status = 'closed';
        if (claim.status === 'ajustador') dispatchClaimId = claimId;
      } else if (e.type === 'cancel') {
        status = 'closed';
        if (conv.claim_id) {
          await db.query(`UPDATE claims SET status = 'cancelado', updated_at = now() WHERE id = $1 AND status = 'borrador'`, [conv.claim_id]);
          await this.audit.record(db, tenant.id, { actor: `whatsapp:${m.from}`, action: 'claim.cancelled', entity: 'claim', entityId: conv.claim_id, data: { step: conv.state.step } });
        }
      } else if (e.type === 'handoff') {
        status = 'handoff';
        await this.audit.record(db, tenant.id, {
          actor: `whatsapp:${m.from}`,
          action: 'claim.handoff',
          entity: 'claim_conversation',
          entityId: conv.id,
          data: { reason: e.reason, step: conv.state.step, claim_id: conv.claim_id },
        });
      }
    }

    const resolved = await Promise.all(outs.map((o) => this.resolve(o, tenant, conv, config, claimNumber)));
    await db.query('UPDATE claim_conversations SET state = $2, status = $3 WHERE id = $1', [conv.id, next, status]);
    const ids = await this.messenger.record(db, tenant, conv.id, resolved, conv.claim_id);
    return { outs: resolved, ids, dispatchClaimId };
  }

  private async conversation(db: Queryable, tenant: Tenant, number: WaNumberRow, m: WaInboundMessage): Promise<ConversationRow> {
    const existing = await one<ConversationRow>(
      db,
      `SELECT * FROM claim_conversations
        WHERE wa_id = $1 AND phone_number_id = $2 AND status IN ('active','handoff')
          AND last_message_at > now() - make_interval(hours => $3)
        ORDER BY last_message_at DESC LIMIT 1 FOR UPDATE`,
      [m.from, number.phone_number_id, CONVERSATION_WINDOW_HOURS],
    );
    if (existing) return existing;
    await db.query(
      `UPDATE claim_conversations SET status = 'closed' WHERE wa_id = $1 AND phone_number_id = $2 AND status <> 'closed'`,
      [m.from, number.phone_number_id],
    );
    // El plazo de aviso se cuenta desde el primer mensaje del asegurado.
    return (await one<ConversationRow>(
      db,
      `INSERT INTO claim_conversations (tenant_id, phone_number_id, wa_id, profile_name, state, first_message_at, last_message_at)
       VALUES ($1,$2,$3,$4,$5,$6,now()) RETURNING *`,
      [tenant.id, number.phone_number_id, m.from, m.profileName ?? null, initialState(), m.timestamp],
    ))!;
  }

  private async lookupIfNeeded(db: Queryable, state: ConversationState, input: Inbound, config: ClaimsConfig): Promise<PolicySnapshot[] | undefined> {
    if (state.step !== 'identificacion' || input.kind !== 'text') return undefined;
    const id = parseIdentifier(input.text);
    if (!id || 'error' in id) return undefined;
    return policyProviderFor(config.policy_source, this.csvPolicies).lookup(db, id);
  }

  private async photosCount(db: Queryable, conv: ConversationRow): Promise<number> {
    const r = await one<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM claim_files WHERE kind = 'photo' AND (conversation_id = $1 OR ($2::uuid IS NOT NULL AND claim_id = $2))`,
      [conv.id, conv.claim_id],
    );
    return r?.n ?? 0;
  }

  private async resolve(o: Outbound, tenant: Tenant, conv: ConversationRow, config: ClaimsConfig, claimNumber: string | null): Promise<ResolvedOut> {
    const fill = (s: string) => s.split(CLAIM_NUMBER_TOKEN).join(claimNumber ?? '');
    if (o.type === 'capture_link') {
      const { token } = signCaptureToken(this.config.linkSecret, conv.claim_id!, tenant.id, config.capture_ttl_hours * 3600);
      return {
        type: 'buttons',
        text: `${o.text}\n${this.config.publicBaseUrl}/capture/${token}`,
        buttons: [{ id: 'fotos:listo', title: 'Listo' }],
      };
    }
    if (o.type === 'text') return { type: 'text', text: fill(o.text) };
    if (o.type === 'buttons') return { ...o, text: fill(o.text) };
    return o;
  }
}
