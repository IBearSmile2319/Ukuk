import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable, many, one } from '../db/db.service';
import { EngineClient } from '../engine/engine.client';
import { AnalyzeResponse, Finding, OcrWord } from '../engine/engine.types';
import { LlmService } from '../llm/llm.service';
import { BlobsService } from '../storage/blobs.service';
import { Tenant } from '../tenancy/tenant';
import { UsageService } from '../usage/usage.service';
import { Level, ListDocumentsQuery, ReviewDto, UploadDocumentDto, normalizeIssuer } from './dto';
import { explainFindings } from './explanation';
import { AcceptedMime, sniffMime } from './file-type';
import { OCR_PROVIDER, OcrProvider } from './ocr/ocr.provider';
import { OCR_FIELD_OF, OCR_MAX_CONFIDENCE, dniFromOcr, mrzFromOcr } from './id-ocr';
import { numberTokens, sameNumbers } from './reuse';
import { MIN_READABLE_WORDS, readabilityFinding, scoreDocument } from './scoring';
import { TemplateRow, TemplatesService, templateLabel } from './templates.service';
import { EXTERNAL_VALIDATORS, ExternalCheck, ExternalValidator, externalFinding } from './validators/external-validator';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Distancia de Hamming máxima entre dHash para considerar que es la misma imagen. */
export const REUSE_MAX_HAMMING = 6;

export type Stage = 'stored' | 'ocr' | 'engine' | 'external' | 'scored';

export interface IncomingFile {
  buffer: Buffer;
  mimetype: string;
  originalname?: string;
  size: number;
}

/** dHash hexadecimal de 64 bits → bigint con signo (texto) para PostgreSQL. */
export function dhashToSigned(hex: string | undefined | null): string | null {
  if (!hex || !/^[0-9a-f]{16}$/i.test(hex)) return null;
  return BigInt.asIntN(64, BigInt(`0x${hex}`)).toString();
}

/** Combina los campos que envió el cliente con lo que el motor leyó (MRZ, XML). */
export function mergeExtracted(provided: Record<string, string>, engine: AnalyzeResponse | null): Record<string, string> {
  const out: Record<string, string> = { ...provided };
  const set = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '' && out[k] === undefined) out[k] = String(v);
  };
  const mrz = engine?.mrz;
  if (mrz) {
    set('dni', mrz.document_number);
    set('apellidos', mrz.surnames);
    set('nombres', mrz.given_names);
    set('fecha_nacimiento', mrz.birth_date);
    set('fecha_vencimiento', mrz.expiry_date);
    set('sexo', mrz.sex);
    set('nacionalidad', mrz.nationality);
  }
  const xml = engine?.xml;
  if (xml) {
    set('ruc_emisor', xml.ruc_emisor);
    set('serie_numero', xml.serie_numero);
    set('total', xml.total);
    set('fecha_emision', xml.fecha_emision);
  }
  return out;
}

function idFromOcrFinding(derived: Record<string, string>): Finding {
  const read = [derived.mrz && 'la MRZ (dígitos de control válidos)', derived.dni && `el número ${derived.dni}`].filter(Boolean);
  return {
    code: 'extraction.id_from_ocr',
    layer: 'extraction',
    severity: 'info',
    confidence: 1,
    message: `Se leyó del documento ${read.join(' y ')}${derived.mrz && derived.dni ? ': se cruzaron entre sí.' : '.'}`,
    region: null,
    evidence: { fields: Object.keys(derived) },
  };
}

function parseFields(raw?: string): Record<string, string> {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestException('fields debe ser un objeto JSON con los datos impresos');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') throw new BadRequestException(`fields.${k} debe ser texto o número`);
    out[k] = String(v);
  }
  return out;
}

function resolveMime(file: IncomingFile): AcceptedMime {
  const sniffed = sniffMime(file.buffer);
  if (sniffed === 'application/zip') {
    throw new UnprocessableEntityException(
      'Los lotes en ZIP se recibirán por /v1/documents/batch (próximamente). Por ahora envíe los archivos uno por uno.',
    );
  }
  if (sniffed) return sniffed;
  const declared = file.mimetype === 'text/xml' ? 'application/xml' : file.mimetype;
  if (declared === 'application/xml') return 'application/xml';
  throw new UnsupportedMediaTypeException(
    'Formato no aceptado. Envíe JPG, PNG, WEBP, TIFF, HEIC, PDF o el XML del comprobante electrónico.',
  );
}

const HEIC_FINDING: Finding = {
  code: 'file.heic_unsupported',
  layer: 'quality',
  severity: 'medium',
  confidence: 1,
  message: 'La foto está en formato HEIC (iPhone) y no se puede analizar. Envíe la misma foto en JPG o PNG.',
  region: null,
  evidence: null,
};

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly db: DbService,
    private readonly blobs: BlobsService,
    private readonly engine: EngineClient,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly llm: LlmService,
    private readonly templates: TemplatesService,
    @Inject(OCR_PROVIDER) private readonly ocr: OcrProvider,
    @Inject(EXTERNAL_VALIDATORS) private readonly validators: ExternalValidator[],
  ) {}

  async analyze(tenant: Tenant, file: IncomingFile | undefined, dto: UploadDocumentDto, actor = 'api') {
    if (!file?.buffer?.length) throw new BadRequestException('Adjunte el archivo en el campo "file"');
    if (file.size > MAX_FILE_BYTES) throw new BadRequestException('El archivo supera 25 MB');
    const mime = resolveMime(file);
    const provided = parseFields(dto.fields);
    const level: Level = dto.level ?? 'verification';
    const issuer = dto.issuer ?? provided.ruc_emisor ?? null;

    const id = await this.db.withTenant(tenant.id, async (db) => {
      const blob = await this.blobs.save(db, tenant, file.buffer, mime, file.originalname);
      const row = await one<{ id: string }>(
        db,
        `INSERT INTO documents (tenant_id, blob_id, sha256, mime_type, filename, document_type, issuer, level,
                                external_ref, provided_fields, progress)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, jsonb_build_array(jsonb_build_object('stage','stored','at',now())))
         RETURNING id`,
        [
          tenant.id,
          blob.id,
          blob.sha256,
          mime,
          file.originalname ?? null,
          dto.document_type ?? null,
          issuer ? normalizeIssuer(issuer) : null,
          level,
          dto.external_ref ?? null,
          provided,
        ],
      );
      await this.audit.record(db, tenant.id, {
        actor,
        action: 'document.received',
        entity: 'document',
        entityId: row!.id,
        data: { sha256: blob.sha256, mime_type: mime, size_bytes: blob.sizeBytes, level, external_ref: dto.external_ref ?? null },
      });
      return row!.id;
    });

    try {
      await this.process(tenant, id, file.buffer, mime, provided, dto, level, issuer, actor);
    } catch (err) {
      await this.db.withTenant(tenant.id, async (db) => {
        await db.query(`UPDATE documents SET status = 'failed', error = $2 WHERE id = $1`, [id, (err as Error).message]);
        await this.audit.record(db, tenant.id, {
          actor,
          action: 'document.failed',
          entity: 'document',
          entityId: id,
          data: { error: (err as Error).message },
        });
      });
      throw err;
    }
    return this.get(tenant, id);
  }

  private async process(
    tenant: Tenant,
    id: string,
    data: Buffer,
    mime: AcceptedMime,
    provided: Record<string, string>,
    dto: UploadDocumentDto,
    level: Level,
    issuer: string | null,
    actor: string,
  ) {
    const findings: Finding[] = [];
    let engineRes: AnalyzeResponse | null = null;
    let words: OcrWord[] = [];
    // Datos del DNI leídos por el OCR cuando el cliente no los envió (MRZ verificada, número).
    let derived: Record<string, string> = {};
    let withOcr: Record<string, string> = provided;
    let template: TemplateRow | undefined;
    let external: ExternalCheck[] = [];

    if (mime === 'image/heic') {
      // El motor no decodifica HEIC: se guarda y se pide otra foto, sin cobrar.
      findings.push(HEIC_FINDING);
    } else {
      try {
        words = await this.ocr.extract(data, mime);
      } catch (err) {
        this.logger.warn(`OCR falló: ${(err as Error).message}`);
        findings.push({
          code: 'ocr.failed',
          layer: 'extraction',
          severity: 'info',
          confidence: 1,
          message: 'El OCR no respondió; el análisis continúa sin posiciones de palabras.',
          region: null,
          evidence: { provider: this.ocr.name },
        });
      }
      await this.stage(tenant, id, 'ocr', { provider: this.ocr.name, words: words.length });
      const unreadable = findings.some((f) => f.code === 'ocr.failed') ? null : readabilityFinding(mime, this.ocr.name, words.length);
      if (unreadable) findings.push(unreadable);
      derived = dto.document_type === 'dni' && words.length ? await this.idFieldsFromOcr(words, provided) : {};
      if (Object.keys(derived).length) findings.push(idFromOcrFinding(derived));
      withOcr = { ...derived, ...provided };

      if (dto.document_type && issuer) {
        const date = /^\d{4}-\d{2}-\d{2}/.test(provided.fecha_emision ?? '')
          ? provided.fecha_emision.slice(0, 10)
          : new Date().toISOString().slice(0, 10);
        template = await this.db.withTenant(tenant.id, (db) => this.templates.findFor(db, dto.document_type!, issuer, date));
      }

      engineRes = await this.engine.analyze({
        file_base64: data.toString('base64'),
        mime_type: mime,
        ...(dto.document_type ? { document_type: dto.document_type } : {}),
        ...(words.length ? { ocr_words: words } : {}),
        ...(Object.keys(withOcr).length ? { fields: withOcr } : {}),
        ...(template
          ? { template: { id: template.id, label: templateLabel(template), anchors: template.anchors, tolerance: template.tolerance } }
          : {}),
      });
      for (const f of engineRes.findings) {
        if (derived[OCR_FIELD_OF[f.code]] === undefined) continue;
        f.confidence = Math.min(f.confidence, OCR_MAX_CONFIDENCE);
        f.message += ' (dato leído por OCR: confírmelo en el documento)';
      }
      findings.push(...engineRes.findings);
      await this.stage(tenant, id, 'engine', { engine_version: engineRes.engine_version, findings: engineRes.findings.length });

      const fields = mergeExtracted(withOcr, engineRes);
      external = await this.runValidators({ tenant, documentType: dto.document_type ?? null, fields });
      for (const check of external) {
        for (const f of check.findings) {
          // El motor puede haber marcado ya el RUC; no se cuenta dos veces.
          if (f.code === 'ruc.invalid' && findings.some((e) => e.code.startsWith('ruc.'))) continue;
          findings.push(f);
        }
      }
      await this.stage(tenant, id, 'external', { sources: external.map((e) => `${e.source}:${e.status}`) });
    }

    const dhash = dhashToSigned(engineRes?.image?.dhash);
    const extracted = mergeExtracted(withOcr, engineRes);

    findings.push(...(await this.db.withTenant(tenant.id, (db) => this.reuseFindings(db, id, dhash, words, !!dto.document_type))));
    const score = scoreDocument(findings, { templateMatched: !!template });
    // Claude solo redacta; se llama fuera de la transacción y no toca puntaje ni veredicto.
    const explanation = await explainFindings(this.llm, {
      documentType: dto.document_type ?? null,
      findings,
      score,
      templateLabel: template ? templateLabel(template) : null,
    });

    await this.db.withTenant(tenant.id, async (db) => {
      await db.query(
        `UPDATE documents SET
           status = 'completed', dhash = $2, score = $3, verdict = $4, retake_required = $5, confidence_note = $6,
           findings = $7, extracted = $8, measurements = $9, external = $10, ocr_provider = $11, ocr_words = $12,
           template_id = $13, template_label = $14, engine_version = $15, explanation = $16, completed_at = now(),
           progress = progress || jsonb_build_array(jsonb_build_object('stage','scored','at',now()))
         WHERE id = $1`,
        [
          id,
          dhash,
          score.score,
          score.verdict,
          score.retake_required,
          score.confidence_note,
          JSON.stringify(findings),
          extracted,
          {
            image: engineRes?.image ?? null,
            pdf: engineRes?.pdf ?? null,
            xml: engineRes?.xml ?? null,
            mrz: engineRes?.mrz ?? null,
            duration_ms: engineRes?.duration_ms ?? null,
          },
          JSON.stringify(external),
          mime === 'image/heic' ? null : this.ocr.name,
          words.length ? JSON.stringify(words) : null,
          template?.id ?? null,
          template ? templateLabel(template) : null,
          engineRes?.engine_version ?? null,
          explanation,
        ],
      );
      await this.audit.record(db, tenant.id, {
        actor,
        action: 'document.analyzed',
        entity: 'document',
        entityId: id,
        data: {
          score: score.score,
          verdict: score.verdict,
          retake_required: score.retake_required,
          findings: findings.map((f) => `${f.code}:${f.severity}`),
          template_id: template?.id ?? null,
          engine_version: engineRes?.engine_version ?? null,
          external: external.map((e) => ({ source: e.source, status: e.status, checked_at: e.checked_at })),
        },
      });
      if (engineRes) await this.usage.record(db, tenant.id, 'documents', level, 1, id);
    });
  }

  private async runValidators(ctx: Parameters<ExternalValidator['validate']>[0]): Promise<ExternalCheck[]> {
    const applicable = this.validators.filter((v) => v.applies(ctx));
    return Promise.all(
      applicable.map((v) =>
        v.validate(ctx).catch(
          (err): ExternalCheck => ({
            source: v.source,
            status: 'error',
            checked_at: new Date().toISOString(),
            request: {},
            response: { error: (err as Error).message },
            findings: [
              externalFinding(`external.${v.source}_error`, 'info', `No se pudo consultar ${v.source}; reintente más tarde.`, {
                error: (err as Error).message,
              }),
            ],
          }),
        ),
      ),
    );
  }

  /** MRZ y número del DNI leídos por el OCR; la MRZ solo se usa si sus dígitos de control cuadran. */
  private async idFieldsFromOcr(words: OcrWord[], provided: Record<string, string>): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const mrz = provided.mrz ? null : mrzFromOcr(words);
    if (mrz && (await this.engine.checkMrz(mrz).catch(() => null))?.valid) out.mrz = mrz;
    const dni = provided.dni ? null : dniFromOcr(words);
    if (dni) out.dni = dni;
    return out;
  }

  /** La misma foto o archivo ya presentado antes por este cliente. */
  private async reuseFindings(db: Queryable, id: string, dhash: string | null, words: OcrWord[], isDocument: boolean): Promise<Finding[]> {
    const out: Finding[] = [];
    const self = await one<{ sha256: string }>(db, 'SELECT sha256 FROM documents WHERE id = $1', [id]);
    const same = await many<{ id: string; external_ref: string | null; created_at: Date }>(
      db,
      `SELECT id, external_ref, created_at FROM documents
        WHERE sha256 = $1 AND id <> $2 ORDER BY created_at LIMIT 5`,
      [self!.sha256, id],
    );
    if (same.length) {
      out.push({
        code: 'reuse.same_file',
        layer: 'reuse',
        severity: 'high',
        confidence: 1,
        message: 'Este mismo archivo ya fue presentado antes.',
        region: null,
        evidence: {
          prior_document_id: same[0].id,
          prior_external_ref: same[0].external_ref,
          prior_created_at: same[0].created_at,
          prior_count: same.length,
        },
      });
    }
    // Un documento sin texto legible no se puede distinguir de otro del mismo formato por su
    // huella: ahí solo cuenta el archivo idéntico (arriba).
    if (dhash !== null && !(isDocument && words.length < MIN_READABLE_WORDS)) {
      const candidates = await many<{ id: string; external_ref: string | null; hamming: number; ocr_words: OcrWord[] | null }>(
        db,
        `SELECT id, external_ref, ocr_words, bit_count((dhash # $1::bigint)::bit(64))::int AS hamming FROM documents
          WHERE dhash IS NOT NULL AND id <> $2 AND sha256 <> $3
            AND bit_count((dhash # $1::bigint)::bit(64)) <= $4
          ORDER BY hamming, created_at LIMIT 20`,
        [dhash, id, self!.sha256, REUSE_MAX_HAMMING],
      );
      // En un documento con texto, la huella solo dice "mismo formato": se exige que también
      // coincidan sus números. En una foto sin tipo de documento basta la huella.
      const mine = numberTokens(words);
      const similar = words.length < MIN_READABLE_WORDS
        ? candidates.slice(0, 5)
        : candidates.filter((c) => sameNumbers(mine, numberTokens(c.ocr_words ?? [])) === true).slice(0, 5);
      if (similar.length) {
        const best = similar[0];
        out.push({
          code: 'reuse.duplicate_image',
          layer: 'reuse',
          severity: 'high',
          confidence: Math.round((1 - best.hamming / 16) * 100) / 100,
          message: 'Una imagen casi idéntica ya fue presentada en otro documento.',
          region: null,
          evidence: {
            prior_document_id: best.id,
            prior_external_ref: best.external_ref,
            hamming: best.hamming,
            matches: similar.map((s) => ({ document_id: s.id, hamming: s.hamming })),
          },
        });
      }
    }
    return out;
  }

  private stage(tenant: Tenant, id: string, stage: Stage, info: Record<string, unknown> = {}) {
    return this.db.withTenant(tenant.id, (db) =>
      db.query(
        `UPDATE documents SET progress = progress || jsonb_build_array(jsonb_build_object('stage',$2::text,'at',now()) || $3::jsonb)
          WHERE id = $1`,
        [id, stage, info],
      ),
    );
  }

  async get(tenant: Tenant, id: string) {
    const row = await this.db.withTenant(tenant.id, (db) => one(db, 'SELECT * FROM documents WHERE id = $1', [id]));
    if (!row) throw new NotFoundException('Documento no encontrado');
    return toReport(row);
  }

  async list(tenant: Tenant, q: ListDocumentsQuery) {
    const limit = q.limit ?? 20;
    const offset = q.offset ?? 0;
    return this.db.withTenant(tenant.id, async (db) => {
      const where = `($1::text IS NULL OR verdict = $1) AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR document_type = $3)
        AND ($4::timestamptz IS NULL OR created_at >= $4) AND ($5::timestamptz IS NULL OR created_at <= $5)`;
      const params = [q.verdict ?? null, q.status ?? null, q.document_type ?? null, q.from ?? null, q.to ?? null];
      const total = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM documents WHERE ${where}`, params);
      const items = await many(
        db,
        `SELECT id, status, document_type, issuer, level, external_ref, filename, mime_type, score, verdict,
                retake_required, review->>'decision' AS review_decision, created_at, completed_at
           FROM documents WHERE ${where} ORDER BY created_at DESC, id LIMIT $6 OFFSET $7`,
        [...params, limit, offset],
      );
      return { items, total: total!.n, limit, offset };
    });
  }

  async file(tenant: Tenant, id: string, actor = 'api') {
    return this.db.withTenant(tenant.id, async (db) => {
      const doc = await one<{ blob_id: string }>(db, 'SELECT blob_id FROM documents WHERE id = $1', [id]);
      if (!doc) throw new NotFoundException('Documento no encontrado');
      const blob = await this.blobs.load(db, tenant, doc.blob_id);
      await this.audit.record(db, tenant.id, { actor, action: 'document.file_downloaded', entity: 'document', entityId: id });
      return blob;
    });
  }

  async review(tenant: Tenant, id: string, dto: ReviewDto, actor = 'api') {
    return this.db.withTenant(tenant.id, async (db) => {
      const doc = await one(db, 'SELECT * FROM documents WHERE id = $1 FOR UPDATE', [id]);
      if (!doc) throw new NotFoundException('Documento no encontrado');
      if (doc.status !== 'completed') throw new ConflictException('El documento aún no termina de analizarse');
      const eligible = canFeedTemplates(doc);
      if (dto.add_to_templates && dto.decision !== 'legitimo') {
        throw new UnprocessableEntityException('Solo un documento marcado como legítimo puede alimentar la biblioteca de plantillas');
      }
      if (dto.add_to_templates && !eligible) {
        throw new UnprocessableEntityException(
          'Para usarlo como muestra de plantilla el documento necesita tipo, emisor y texto reconocido por OCR',
        );
      }
      const review = { decision: dto.decision, notes: dto.notes ?? null, by: actor, at: new Date().toISOString() };
      const sample = dto.decision === 'legitimo' && !!dto.add_to_templates;
      await db.query('UPDATE documents SET review = $2, template_sample = $3 WHERE id = $1', [id, review, sample]);
      await this.audit.record(db, tenant.id, {
        actor,
        action: 'document.reviewed',
        entity: 'document',
        entityId: id,
        data: { decision: dto.decision, notes: dto.notes ?? null, previous_verdict: doc.verdict, template_sample: sample },
      });
      let samples: number | null = null;
      if (sample) {
        const n = await one<{ n: number }>(
          db,
          'SELECT count(*)::int AS n FROM documents WHERE template_sample AND document_type = $1 AND issuer = $2',
          [doc.document_type, doc.issuer],
        );
        samples = n!.n;
      }
      return {
        id,
        review,
        template_sample: sample,
        can_add_to_templates: dto.decision === 'legitimo' && eligible && !sample,
        template_samples: samples,
      };
    });
  }
}

function canFeedTemplates(row: any): boolean {
  return !!row.document_type && !!row.issuer && Array.isArray(row.ocr_words) && row.ocr_words.length > 0;
}

export function toReport(row: any) {
  return {
    id: row.id,
    status: row.status,
    document_type: row.document_type,
    issuer: row.issuer,
    level: row.level,
    external_ref: row.external_ref,
    filename: row.filename,
    mime_type: row.mime_type,
    sha256: row.sha256,
    score: row.score,
    verdict: row.verdict,
    retake_required: row.retake_required,
    confidence_note: row.confidence_note,
    findings: row.findings,
    extracted_fields: row.extracted,
    provided_fields: row.provided_fields,
    measurements: row.measurements,
    external: row.external,
    template: row.template_label ? { id: row.template_id, label: row.template_label } : null,
    engine_version: row.engine_version,
    ocr: { provider: row.ocr_provider, words: row.ocr_words ?? [] },
    explanation: row.explanation,
    progress: row.progress,
    review: row.review,
    template_sample: row.template_sample,
    can_add_to_templates: row.review?.decision === 'legitimo' && !row.template_sample && canFeedTemplates(row),
    error: row.error,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}
