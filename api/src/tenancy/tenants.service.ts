import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { CryptoService } from '../crypto/crypto.service';
import { DbService } from '../db/db.service';
import { EntityType, ServiceModule, Tenant, rowToTenant } from './tenant';

export function hashApiKey(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

export interface CreateTenantInput {
  name: string;
  ruc?: string;
  entityType: EntityType;
  businessLines?: string[];
  modules: ServiceModule[];
  settings?: Record<string, unknown>;
}

@Injectable()
export class TenantsService {
  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
  ) {}

  async create(input: CreateTenantInput): Promise<Tenant> {
    const id = (await this.db.query<{ id: string }>('SELECT gen_random_uuid() AS id'))[0].id;
    const rows = await this.db.query(
      `INSERT INTO tenants (id, name, ruc, entity_type, business_lines, modules, data_key_enc, settings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        id,
        input.name,
        input.ruc ?? null,
        input.entityType,
        input.businessLines ?? [],
        input.modules,
        this.crypto.newWrappedDataKey(id),
        input.settings ?? {},
      ],
    );
    return rowToTenant(rows[0]);
  }

  async update(
    id: string,
    patch: Partial<Pick<CreateTenantInput, 'modules' | 'businessLines' | 'settings' | 'entityType'>>,
  ): Promise<Tenant> {
    const rows = await this.db.query(
      `UPDATE tenants SET
         modules = COALESCE($2, modules),
         business_lines = COALESCE($3, business_lines),
         settings = COALESCE($4, settings),
         entity_type = COALESCE($5, entity_type)
       WHERE id = $1 RETURNING *`,
      [id, patch.modules ?? null, patch.businessLines ?? null, patch.settings ?? null, patch.entityType ?? null],
    );
    if (!rows[0]) throw new NotFoundException('Cliente no encontrado');
    return rowToTenant(rows[0]);
  }

  async get(id: string): Promise<Tenant> {
    const rows = await this.db.query('SELECT * FROM tenants WHERE id = $1', [id]);
    if (!rows[0]) throw new NotFoundException('Cliente no encontrado');
    return rowToTenant(rows[0]);
  }

  async listActive(module?: ServiceModule): Promise<Tenant[]> {
    const rows = await this.db.query(
      `SELECT * FROM tenants WHERE status = 'active' AND ($1::text IS NULL OR $1 = ANY(modules))`,
      [module ?? null],
    );
    return rows.map(rowToTenant);
  }

  /** Devuelve la llave en claro una sola vez; solo se guarda su hash. */
  async createApiKey(tenantId: string, name: string): Promise<{ id: string; key: string }> {
    const prefix = randomBytes(4).toString('hex');
    const key = `uk_live_${prefix}_${randomBytes(24).toString('base64url')}`;
    const rows = await this.db.query<{ id: string }>(
      `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
      [tenantId, name, prefix, hashApiKey(key)],
    );
    return { id: rows[0].id, key };
  }

  async revokeApiKey(tenantId: string, keyId: string): Promise<void> {
    await this.db.query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL',
      [keyId, tenantId],
    );
  }

  async findByApiKey(key: string): Promise<Tenant | undefined> {
    const rows = await this.db.query(
      `UPDATE api_keys k SET last_used_at = now()
         FROM tenants t
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND t.id = k.tenant_id AND t.status = 'active'
       RETURNING t.*`,
      [hashApiKey(key)],
    );
    return rows[0] ? rowToTenant(rows[0]) : undefined;
  }
}
