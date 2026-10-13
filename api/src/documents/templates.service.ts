import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable, many, one } from '../db/db.service';
import { OcrWord, TemplateProfile } from '../engine/engine.types';
import { Tenant } from '../tenancy/tenant';
import { CreateTemplateDto, ListTemplatesQuery, TemplateFromSamplesDto, normalizeIssuer } from './dto';
import { buildAnchors } from './template-builder';

const COLUMNS = `id, document_type, issuer, version_label, valid_from::text AS valid_from, valid_to::text AS valid_to,
  anchors, tolerance, sample_count, created_at`;

export interface TemplateRow {
  id: string;
  document_type: string;
  issuer: string;
  version_label: string;
  valid_from: string;
  valid_to: string | null;
  anchors: TemplateProfile['anchors'];
  tolerance: number;
  sample_count: number;
  created_at: Date;
}

export function templateLabel(t: Pick<TemplateRow, 'issuer' | 'version_label' | 'valid_from' | 'valid_to'>): string {
  return `${t.issuer} ${t.version_label} (${t.valid_from}..${t.valid_to ?? ''})`;
}

/** Biblioteca de plantillas por tipo de documento, emisor, versión y rango de fechas. */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Perfil vigente en la fecha del propio documento. */
  async findFor(db: Queryable, documentType: string, issuer: string, date: string): Promise<TemplateRow | undefined> {
    return one<TemplateRow>(
      db,
      `SELECT ${COLUMNS} FROM document_templates
        WHERE document_type = $1 AND issuer = $2 AND valid_from <= $3::date
          AND (valid_to IS NULL OR valid_to >= $3::date)
        ORDER BY valid_from DESC LIMIT 1`,
      [documentType, normalizeIssuer(issuer), date],
    );
  }

  list(tenant: Tenant, q: ListTemplatesQuery): Promise<TemplateRow[]> {
    return this.db.withTenant(tenant.id, (db) =>
      many<TemplateRow>(
        db,
        `SELECT ${COLUMNS} FROM document_templates
          WHERE ($1::text IS NULL OR document_type = $1) AND ($2::text IS NULL OR issuer = $2)
          ORDER BY document_type, issuer, valid_from DESC`,
        [q.document_type ?? null, q.issuer ? normalizeIssuer(q.issuer) : null],
      ),
    );
  }

  create(tenant: Tenant, dto: CreateTemplateDto, actor = 'api'): Promise<TemplateRow> {
    return this.db.withTenant(tenant.id, (db) => this.insert(db, tenant, dto, dto.anchors, 0, actor));
  }

  async remove(tenant: Tenant, id: string, actor = 'api'): Promise<{ deleted: true }> {
    return this.db.withTenant(tenant.id, async (db) => {
      const row = await one(db, 'DELETE FROM document_templates WHERE id = $1 RETURNING id, document_type, issuer, version_label', [id]);
      if (!row) throw new NotFoundException('Plantilla no encontrada');
      await this.audit.record(db, tenant.id, {
        actor,
        action: 'document_template.deleted',
        entity: 'document_template',
        entityId: id,
        data: { document_type: row.document_type, issuer: row.issuer, version_label: row.version_label },
      });
      return { deleted: true as const };
    });
  }

  async fromSamples(tenant: Tenant, dto: TemplateFromSamplesDto, actor = 'api'): Promise<TemplateRow> {
    return this.db.withTenant(tenant.id, async (db) => {
      const issuer = normalizeIssuer(dto.issuer);
      const rows = dto.document_ids
        ? await many<{ id: string; ocr_words: OcrWord[] | null }>(
            db,
            'SELECT id, ocr_words FROM documents WHERE id = ANY($1::uuid[])',
            [dto.document_ids],
          )
        : await many<{ id: string; ocr_words: OcrWord[] | null }>(
            db,
            `SELECT id, ocr_words FROM documents
              WHERE template_sample AND document_type = $1 AND issuer = $2 ORDER BY created_at DESC LIMIT 200`,
            [dto.document_type, issuer],
          );
      if (dto.document_ids && rows.length !== new Set(dto.document_ids).size) {
        throw new NotFoundException('Alguno de los documentos de muestra no existe');
      }
      const samples = rows.map((r) => r.ocr_words ?? []).filter((w) => w.length > 0);
      if (samples.length === 0) {
        throw new UnprocessableEntityException(
          'No hay muestras con texto reconocido (OCR). Suba documentos legítimos con OCR activo o marque documentos como legítimos.',
        );
      }
      const anchors = buildAnchors(samples, { minPresence: dto.min_presence }).map(({ text, bbox }) => ({ text, bbox }));
      if (anchors.length === 0) {
        throw new UnprocessableEntityException('Las muestras no comparten palabras en posiciones parecidas.');
      }
      return this.insert(db, tenant, dto, anchors, samples.length, actor, rows.map((r) => r.id));
    });
  }

  private async insert(
    db: Queryable,
    tenant: Tenant,
    dto: CreateTemplateDto | TemplateFromSamplesDto,
    anchors: TemplateProfile['anchors'],
    sampleCount: number,
    actor: string,
    sampleIds?: string[],
  ): Promise<TemplateRow> {
    if (dto.valid_to && dto.valid_to < dto.valid_from) {
      throw new UnprocessableEntityException('valid_to no puede ser anterior a valid_from');
    }
    const row = await one<TemplateRow>(
      db,
      `INSERT INTO document_templates (tenant_id, document_type, issuer, version_label, valid_from, valid_to, anchors, tolerance, sample_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLUMNS}`,
      [
        tenant.id,
        dto.document_type,
        normalizeIssuer(dto.issuer),
        dto.version_label,
        dto.valid_from,
        dto.valid_to ?? null,
        JSON.stringify(anchors),
        dto.tolerance ?? 0.03,
        sampleCount,
      ],
    );
    await this.audit.record(db, tenant.id, {
      actor,
      action: 'document_template.created',
      entity: 'document_template',
      entityId: row!.id,
      data: {
        document_type: row!.document_type,
        issuer: row!.issuer,
        version_label: row!.version_label,
        anchors: anchors.length,
        ...(sampleIds ? { sample_document_ids: sampleIds } : {}),
      },
    });
    return row!;
  }
}
