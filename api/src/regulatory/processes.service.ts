import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { parseCsv } from '../common/csv';
import { DbService, Queryable, many, one } from '../db/db.service';
import { Tenant } from '../tenancy/tenant';
import { PROCESS_KINDS, ProcessDto, ProcessKind, UpdateProcessDto } from './dto';
import { ImpactsService } from './impacts.service';

const COLUMNS = 'id, code, name, kind, description, owner_email, topics, keywords, created_at, updated_at';
const list = (s: string | undefined) =>
  (s ?? '')
    .split(/[|,]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Inventario de políticas y procesos del cliente. Cada cambio recalcula impactos. */
@Injectable()
export class ProcessesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly impacts: ImpactsService,
  ) {}

  list(tenant: Tenant) {
    return this.db.withTenant(tenant.id, (db) => many(db, `SELECT ${COLUMNS} FROM reg_processes ORDER BY code`));
  }

  private async upsert(db: Queryable, tenant: Tenant, p: ProcessDto) {
    return one(
      db,
      `INSERT INTO reg_processes (tenant_id, code, name, kind, description, owner_email, topics, keywords)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind,
         description = EXCLUDED.description, owner_email = EXCLUDED.owner_email, topics = EXCLUDED.topics,
         keywords = EXCLUDED.keywords, updated_at = now()
       RETURNING ${COLUMNS}, (xmax = 0) AS created`,
      [tenant.id, p.code, p.name, p.kind, p.description ?? '', p.owner_email ?? null, p.topics ?? [], p.keywords ?? []],
    );
  }

  async create(tenant: Tenant, dto: ProcessDto, actor: string) {
    const row = await this.db.withTenant(tenant.id, async (db) => {
      if (await one(db, 'SELECT 1 FROM reg_processes WHERE code = $1', [dto.code])) {
        throw new ConflictException(`Ya existe el proceso ${dto.code}`);
      }
      const r = await this.upsert(db, tenant, dto);
      await this.audit.record(db, tenant.id, { actor, action: 'regulatory.process_created', entity: 'reg_process', entityId: r!.id, data: { code: dto.code } });
      return r;
    });
    await this.impacts.recomputeTenant(tenant);
    return row;
  }

  async update(tenant: Tenant, id: string, dto: UpdateProcessDto, actor: string) {
    const row = await this.db.withTenant(tenant.id, async (db) => {
      const r = await one(
        db,
        `UPDATE reg_processes SET name = COALESCE($2, name), kind = COALESCE($3, kind),
           description = COALESCE($4, description), owner_email = COALESCE($5, owner_email),
           topics = COALESCE($6, topics), keywords = COALESCE($7, keywords), updated_at = now()
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, dto.name ?? null, dto.kind ?? null, dto.description ?? null, dto.owner_email ?? null, dto.topics ?? null, dto.keywords ?? null],
      );
      if (!r) throw new NotFoundException('Proceso no encontrado');
      await this.audit.record(db, tenant.id, { actor, action: 'regulatory.process_updated', entity: 'reg_process', entityId: id, data: { ...dto } });
      return r;
    });
    await this.impacts.recomputeTenant(tenant);
    return row;
  }

  async remove(tenant: Tenant, id: string, actor: string) {
    await this.db.withTenant(tenant.id, async (db) => {
      const r = await one(db, 'DELETE FROM reg_processes WHERE id = $1 RETURNING code', [id]);
      if (!r) throw new NotFoundException('Proceso no encontrado');
      await this.audit.record(db, tenant.id, { actor, action: 'regulatory.process_deleted', entity: 'reg_process', entityId: id, data: { code: r.code } });
    });
    return { deleted: true };
  }

  /** CSV: code,name,kind,description,owner_email,topics,keywords (listas separadas por "|"). */
  async importCsv(tenant: Tenant, csv: string, actor: string) {
    const rows = parseCsv(csv);
    if (!rows.length) throw new BadRequestException('El CSV no tiene filas');
    const errors: { line: number; error: string }[] = [];
    const valid: ProcessDto[] = [];
    rows.forEach((r, i) => {
      const kind = (r.kind || 'proceso').toLowerCase() as ProcessKind;
      if (!r.code || !r.name) errors.push({ line: i + 2, error: 'code y name son obligatorios' });
      else if (!PROCESS_KINDS.includes(kind)) errors.push({ line: i + 2, error: `kind inválido: ${r.kind}` });
      else if (r.owner_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.owner_email)) errors.push({ line: i + 2, error: 'owner_email inválido' });
      else
        valid.push({
          code: r.code,
          name: r.name,
          kind,
          description: r.description,
          owner_email: r.owner_email || undefined,
          topics: list(r.topics).map((t) => t.toLowerCase()),
          keywords: list(r.keywords),
        });
    });
    let created = 0;
    await this.db.withTenant(tenant.id, async (db) => {
      for (const p of valid) if ((await this.upsert(db, tenant, p))?.created) created++;
      await this.audit.record(db, tenant.id, {
        actor,
        action: 'regulatory.processes_imported',
        entity: 'reg_process',
        data: { rows: rows.length, imported: valid.length, created, errors: errors.length },
      });
    });
    const impacts = await this.impacts.recomputeTenant(tenant);
    return { imported: valid.length, created, updated: valid.length - created, errors, impacts };
  }
}
