import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DbService, many, one } from '../db/db.service';
import { Tenant } from '../tenancy/tenant';
import { CreateTaskDto, TasksQueryDto, UpdateTaskDto } from './dto';
import { limaToday } from './impacts.service';

const COLUMNS = `t.id, t.impact_id, t.title, t.responsible_email, to_char(t.due_at,'YYYY-MM-DD') AS due_at, t.status,
  t.closed_at, t.evidence, t.created_at, t.updated_at,
  (t.status <> 'cerrada' AND t.due_at < $1::date) AS overdue`;

/** Tareas de adecuación con responsable y plazo. */
@Injectable()
export class TasksService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  list(tenant: Tenant, q: TasksQueryDto) {
    return this.db.withTenant(tenant.id, (db) =>
      many(
        db,
        `SELECT ${COLUMNS}, n.number AS norm_number, n.title AS norm_title, p.code AS process_code
           FROM reg_tasks t
           JOIN reg_impacts i ON i.id = t.impact_id
           JOIN reg_norms n ON n.id = i.norm_id
           JOIN reg_processes p ON p.id = i.process_id
          WHERE ($2::text IS NULL OR t.status = $2) AND ($3::text IS NULL OR t.responsible_email = $3)
            AND (NOT $4 OR (t.status <> 'cerrada' AND t.due_at < $1::date))
          ORDER BY t.due_at, t.created_at`,
        [limaToday(), q.status ?? null, q.responsible_email ?? null, q.overdue === 'true'],
      ),
    );
  }

  async create(tenant: Tenant, dto: CreateTaskDto, actor: string) {
    return this.db.withTenant(tenant.id, async (db) => {
      if (!(await one(db, 'SELECT 1 FROM reg_impacts WHERE id = $1', [dto.impact_id]))) {
        throw new NotFoundException('Impacto no encontrado');
      }
      const row = await one(
        db,
        `INSERT INTO reg_tasks AS t (tenant_id, impact_id, title, responsible_email, due_at)
         VALUES ($2,$3,$4,$5,$6) RETURNING ${COLUMNS}`,
        [limaToday(), tenant.id, dto.impact_id, dto.title, dto.responsible_email.toLowerCase(), dto.due_at.slice(0, 10)],
      );
      // Abrir una tarea implica que el impacto entró en adecuación.
      await db.query(`UPDATE reg_impacts SET status = 'en_adecuacion', updated_at = now() WHERE id = $1 AND status = 'pendiente'`, [dto.impact_id]);
      await this.audit.record(db, tenant.id, { actor, action: 'regulatory.task_created', entity: 'reg_task', entityId: row!.id, data: { ...dto } });
      return row;
    });
  }

  async update(tenant: Tenant, id: string, dto: UpdateTaskDto, actor: string) {
    return this.db.withTenant(tenant.id, async (db) => {
      const before = await one(db, 'SELECT status FROM reg_tasks WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw new NotFoundException('Tarea no encontrada');
      const row = await one(
        db,
        `UPDATE reg_tasks t SET title = COALESCE($3, title), responsible_email = COALESCE($4, responsible_email),
           due_at = COALESCE($5::date, due_at), status = COALESCE($6, status), evidence = COALESCE($7, evidence),
           closed_at = CASE WHEN $6 = 'cerrada' AND status <> 'cerrada' THEN now()
                            WHEN $6 IS NOT NULL AND $6 <> 'cerrada' THEN NULL ELSE closed_at END,
           updated_at = now()
         WHERE id = $2 RETURNING ${COLUMNS}`,
        [
          limaToday(),
          id,
          dto.title ?? null,
          dto.responsible_email?.toLowerCase() ?? null,
          dto.due_at?.slice(0, 10) ?? null,
          dto.status ?? null,
          dto.evidence ?? null,
        ],
      );
      await this.audit.record(db, tenant.id, {
        actor,
        action: dto.status === 'cerrada' && before.status !== 'cerrada' ? 'regulatory.task_closed' : 'regulatory.task_updated',
        entity: 'reg_task',
        entityId: id,
        data: { ...dto, from_status: before.status },
      });
      return row;
    });
  }

  async remove(tenant: Tenant, id: string, actor: string) {
    await this.db.withTenant(tenant.id, async (db) => {
      const r = await one(db, 'DELETE FROM reg_tasks WHERE id = $1 RETURNING title', [id]);
      if (!r) throw new NotFoundException('Tarea no encontrada');
      await this.audit.record(db, tenant.id, { actor, action: 'regulatory.task_deleted', entity: 'reg_task', entityId: id, data: { title: r.title } });
    });
    return { deleted: true };
  }
}
