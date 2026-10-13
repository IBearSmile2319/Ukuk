import { Injectable, Logger } from '@nestjs/common';
import { Queryable, one } from '../db/db.service';
import { EngineClient } from '../engine/engine.client';
import { DocumentType, Finding } from '../engine/engine.types';
import { BlobsService } from '../storage/blobs.service';
import { Tenant } from '../tenancy/tenant';

export type FileKind = 'photo' | 'document' | 'audio' | 'video';

export interface StoreFileInput {
  data: Buffer;
  mimeType: string;
  kind: FileKind;
  source: 'whatsapp' | 'capture';
  claimId?: string | null;
  conversationId?: string | null;
  docType?: string | null;
  engineType?: DocumentType;
  filename?: string;
  /** Hallazgos propios (GPS, reloj) que se suman a los del motor. */
  extraFindings?: Finding[];
  capture?: Record<string, unknown>;
}

const ANALYZABLE = /^(image\/(jpeg|png|webp|tiff)|application\/pdf)$/;

export const finding = (
  code: string,
  severity: Finding['severity'],
  message: string,
  evidence?: Record<string, unknown>,
): Finding => ({ code, layer: 'external', severity, confidence: 1, message, evidence: evidence ?? null });

/**
 * Guarda cada archivo del caso cifrado, lo pasa por el motor (fotos y PDF) y busca
 * reutilización dentro del mismo cliente (hash exacto o dHash parecido en otro caso).
 */
@Injectable()
export class ClaimFilesService {
  private readonly logger = new Logger(ClaimFilesService.name);

  constructor(
    private readonly blobs: BlobsService,
    private readonly engine: EngineClient,
  ) {}

  async store(db: Queryable, tenant: Tenant, f: StoreFileInput) {
    const blob = await this.blobs.save(db, tenant, f.data, f.mimeType, f.filename);
    const findings: Finding[] = [...(f.extraFindings ?? [])];
    let analysis: Record<string, unknown> | null = null;
    let dhash: string | null = null;
    if (ANALYZABLE.test(f.mimeType)) {
      try {
        const res = await this.engine.analyze({
          file_base64: f.data.toString('base64'),
          mime_type: f.mimeType,
          ...(f.engineType ? { document_type: f.engineType } : {}),
        });
        findings.push(...res.findings);
        dhash = res.image?.dhash && /^[0-9a-f]{16}$/i.test(res.image.dhash) ? res.image.dhash.toLowerCase() : null;
        analysis = { engine_version: res.engine_version, image: res.image ?? null, pdf: res.pdf ?? null, duration_ms: res.duration_ms };
      } catch (err) {
        // Sin motor el caso igual se registra; el analista ve que falta el análisis.
        this.logger.warn(`Motor no disponible para el archivo ${blob.id}: ${(err as Error).message}`);
        findings.push(finding('analisis_pendiente', 'info', 'No se pudo analizar el archivo; reintentar más tarde.'));
      }
    }
    // Documentos de identidad pueden repetirse legítimamente entre casos del mismo asegurado.
    const identityDoc = /dni|licencia/.test(f.docType ?? '');
    if (f.kind === 'photo' || (f.kind === 'document' && !identityDoc)) {
      findings.push(...(await this.reuse(db, blob.sha256, f.kind === 'photo' ? dhash : null, f.claimId ?? null, f.conversationId ?? null)));
    }
    const row = await one<{ id: string }>(
      db,
      `INSERT INTO claim_files (tenant_id, claim_id, conversation_id, blob_id, kind, source, doc_type, mime_type, sha256, dhash, analysis, findings, capture)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        tenant.id,
        f.claimId ?? null,
        f.conversationId ?? null,
        blob.id,
        f.kind,
        f.source,
        f.docType ?? null,
        f.mimeType,
        blob.sha256,
        dhash,
        analysis,
        JSON.stringify(findings),
        f.capture ?? null,
      ],
    );
    return { id: row!.id, blobId: blob.id, sha256: blob.sha256, findings };
  }

  private async reuse(db: Queryable, sha256: string, dhash: string | null, claimId: string | null, convId: string | null): Promise<Finding[]> {
    const other = `(claim_id IS DISTINCT FROM $2::uuid OR $2::uuid IS NULL) AND (conversation_id IS DISTINCT FROM $3::uuid OR $3::uuid IS NULL)
                   AND claim_id IS NOT NULL`;
    const exact = await one<{ claim_id: string }>(
      db,
      `SELECT claim_id FROM claim_files WHERE sha256 = $1 AND ${other} LIMIT 1`,
      [sha256, claimId, convId],
    );
    if (exact) {
      return [{ ...finding('foto_reutilizada', 'high', 'El mismo archivo ya se presentó en otro siniestro.', { claim_id: exact.claim_id }), layer: 'reuse' }];
    }
    if (!dhash) return [];
    const similar = await one<{ claim_id: string; distance: number }>(
      db,
      `SELECT claim_id, bit_count(('x' || dhash)::bit(64) # ('x' || $1)::bit(64))::int AS distance
         FROM claim_files
        WHERE dhash IS NOT NULL AND kind = 'photo' AND ${other}
          AND bit_count(('x' || dhash)::bit(64) # ('x' || $1)::bit(64)) <= 6
        ORDER BY distance LIMIT 1`,
      [dhash, claimId, convId],
    );
    return similar
      ? [{ ...finding('foto_similar', 'high', 'Una foto casi idéntica ya se presentó en otro siniestro.', { claim_id: similar.claim_id, distance: similar.distance }), layer: 'reuse' }]
      : [];
  }
}
