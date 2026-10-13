import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DbService, Queryable, many, one } from '../db/db.service';

export interface AuditEntry {
  actor: string;
  action: string;
  entity: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
}

/** JSON con llaves ordenadas, para que el hash no dependa del orden de inserción. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

export function auditHash(prev: Buffer | null, at: string, e: AuditEntry): Buffer {
  return createHash('sha256')
    .update(prev ?? Buffer.alloc(0))
    .update(
      canonicalJson({
        at,
        actor: e.actor,
        action: e.action,
        entity: e.entity,
        entity_id: e.entityId ?? null,
        data: e.data ?? {},
      }),
    )
    .digest();
}

/**
 * Registro de auditoría encadenado: cada fila guarda el hash de la anterior del
 * mismo cliente, así que borrar o editar una fila rompe la cadena y `verify` lo detecta.
 */
@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  /** Debe llamarse dentro de `withTenant` para que quede en la misma transacción. */
  async record(db: Queryable, tenantId: string, e: AuditEntry): Promise<void> {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${tenantId}`]);
    const prev = await one<{ hash: Buffer }>(
      db,
      'SELECT hash FROM audit_log WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1',
      [tenantId],
    );
    const at = new Date().toISOString();
    const hash = auditHash(prev?.hash ?? null, at, e);
    await db.query(
      `INSERT INTO audit_log (tenant_id, at, actor, action, entity, entity_id, data, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, at, e.actor, e.action, e.entity, e.entityId ?? null, e.data ?? {}, prev?.hash ?? null, hash],
    );
  }

  async list(tenantId: string, opts: { entity?: string; entityId?: string; limit?: number }) {
    return this.db.withTenant(tenantId, (db) =>
      many(
        db,
        `SELECT id, at, actor, action, entity, entity_id, data, encode(hash,'hex') AS hash
           FROM audit_log
          WHERE ($1::text IS NULL OR entity = $1) AND ($2::text IS NULL OR entity_id = $2)
          ORDER BY id DESC LIMIT $3`,
        [opts.entity ?? null, opts.entityId ?? null, Math.min(opts.limit ?? 100, 1000)],
      ),
    );
  }

  /** Recalcula toda la cadena del cliente. */
  async verify(tenantId: string): Promise<{ ok: boolean; entries: number; brokenAt?: number }> {
    return this.db.withTenant(tenantId, async (db) => {
      const rows = await many(
        db,
        'SELECT id, at, actor, action, entity, entity_id, data, prev_hash, hash FROM audit_log ORDER BY id',
      );
      let prev: Buffer | null = null;
      for (const r of rows) {
        const expected = auditHash(prev, new Date(r.at).toISOString(), {
          actor: r.actor,
          action: r.action,
          entity: r.entity,
          entityId: r.entity_id,
          data: r.data,
        });
        const prevOk = (prev === null && r.prev_hash === null) || (prev && r.prev_hash?.equals(prev));
        if (!prevOk || !expected.equals(r.hash)) return { ok: false, entries: rows.length, brokenAt: Number(r.id) };
        prev = r.hash;
      }
      return { ok: true, entries: rows.length };
    });
  }
}
