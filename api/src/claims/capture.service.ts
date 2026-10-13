import { BadRequestException, GoneException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService, one } from '../db/db.service';
import { Finding } from '../engine/engine.types';
import { Tenant } from '../tenancy/tenant';
import { TenantsService } from '../tenancy/tenants.service';
import { verifyCaptureToken } from './capture-token';
import { ClaimFilesService, finding } from './claim-files.service';
import { ClaimsService } from './claims.service';
import { CapturePhotoDto } from './dto';
import { haversineKm, isValidLatLng } from './geo';

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export interface CaptureCheck {
  findings: Finding[];
  capture: Record<string, unknown>;
}

/** Metadatos de la captura en vivo y sus hallazgos (GPS lejos del lugar declarado, reloj desfasado). */
export function checkCapture(
  photo: Pick<CapturePhotoDto, 'lat' | 'lng' | 'accuracy' | 'captured_at'>,
  claimLocation: { lat?: number; lng?: number } | null,
  serverTime: Date,
  opts: { gpsMaxKm: number; maxDriftMinutes: number },
): CaptureCheck {
  const findings: Finding[] = [];
  const point = { lat: photo.lat, lng: photo.lng };
  const hasGps = isValidLatLng(point);
  let distanceKm: number | null = null;
  if (!hasGps) {
    findings.push(finding('sin_gps', 'medium', 'La foto se tomó sin ubicación GPS.'));
  } else if (claimLocation && isValidLatLng(claimLocation)) {
    distanceKm = Math.round(haversineKm(point, claimLocation) * 100) / 100;
    if (distanceKm > opts.gpsMaxKm) {
      findings.push(
        finding('gps_lejano', 'medium', `La foto se tomó a ${distanceKm} km del lugar declarado (máximo ${opts.gpsMaxKm} km).`, {
          distance_km: distanceKm,
          photo: point,
          declared: claimLocation,
        }),
      );
    }
  }
  const deviceTime = photo.captured_at ? new Date(photo.captured_at) : null;
  const driftSeconds = deviceTime ? Math.round((serverTime.getTime() - deviceTime.getTime()) / 1000) : null;
  if (driftSeconds !== null && Math.abs(driftSeconds) > opts.maxDriftMinutes * 60) {
    findings.push(
      finding('reloj_desfasado', 'medium', `La hora del celular difiere ${Math.round(driftSeconds / 60)} min de la del servidor.`, {
        drift_seconds: driftSeconds,
      }),
    );
  }
  return {
    findings,
    capture: {
      lat: hasGps ? photo.lat : null,
      lng: hasGps ? photo.lng : null,
      accuracy_m: photo.accuracy ?? null,
      device_time: deviceTime?.toISOString() ?? null,
      server_time: serverTime.toISOString(),
      drift_seconds: driftSeconds,
      distance_km: distanceKm,
    },
  };
}

@Injectable()
export class CaptureService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly tenants: TenantsService,
    private readonly files: ClaimFilesService,
    private readonly claims: ClaimsService,
    private readonly audit: AuditService,
  ) {}

  /** Verifica el token y devuelve el caso; lanza 404/410 si no corresponde. */
  async open(token: string): Promise<{ tenant: Tenant; claim: { id: string; number: string; status: string } }> {
    const v = verifyCaptureToken(this.config.linkSecret, token);
    if (!v.ok) {
      if (v.reason === 'expired') throw new GoneException('El enlace venció. Pida uno nuevo por WhatsApp.');
      throw new NotFoundException('Enlace inválido');
    }
    const tenant = await this.tenants.get(v.payload.tenantId).catch(() => undefined);
    if (!tenant || !tenant.modules.includes('claims')) throw new NotFoundException('Enlace inválido');
    const claim = await this.db.withTenant(tenant.id, (db) =>
      one(db, 'SELECT id, number, status FROM claims WHERE id = $1', [v.payload.claimId]),
    );
    if (!claim) throw new NotFoundException('Enlace inválido');
    if (['cancelado', 'aprobado', 'rechazado', 'consentido'].includes(claim.status)) {
      throw new GoneException('Este siniestro ya no recibe fotos.');
    }
    return { tenant, claim: claim as { id: string; number: string; status: string } };
  }

  async upload(token: string, photos: CapturePhotoDto[]) {
    const { tenant, claim } = await this.open(token);
    const serverTime = new Date();
    const decoded = photos.map((p) => {
      const data = Buffer.from(p.image_base64, 'base64');
      if (!data.length || data.length > MAX_PHOTO_BYTES) throw new BadRequestException('Foto vacía o mayor a 8 MB');
      return { p, data };
    });
    return this.db.withTenant(tenant.id, async (db) => {
      const cfg = await this.claims.config(db);
      const c = await one(db, 'SELECT location, conversation_id, status FROM claims WHERE id = $1 FOR UPDATE', [claim.id]);
      const results = [];
      for (const { p, data } of decoded) {
        const check = checkCapture(p, c?.location ?? null, serverTime, { gpsMaxKm: cfg.gps_max_km, maxDriftMinutes: cfg.max_clock_drift_minutes });
        const stored = await this.files.store(db, tenant, {
          data,
          mimeType: p.mime_type,
          kind: 'photo',
          source: 'capture',
          claimId: claim.id,
          conversationId: c?.conversation_id ?? null,
          extraFindings: check.findings,
          capture: check.capture,
        });
        results.push({ id: stored.id, findings: stored.findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message })) });
      }
      // Si el caso ya fue enviado, el riesgo se recalcula con las fotos nuevas.
      if (c?.status !== 'borrador') await this.claims.refreshRisk(db, claim.id, serverTime);
      await this.audit.record(db, tenant.id, {
        actor: 'capture_link',
        action: 'claim.photos_captured',
        entity: 'claim',
        entityId: claim.id,
        data: { files: results.map((r) => r.id), findings: results.flatMap((r) => r.findings.map((f) => f.code)) },
      });
      const total = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM claim_files WHERE claim_id = $1 AND kind = 'photo'`, [claim.id]);
      return { received: results.length, total_photos: total?.n ?? results.length, files: results };
    });
  }
}
