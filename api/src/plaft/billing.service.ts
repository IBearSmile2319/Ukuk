import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService, one } from '../db/db.service';
import { TenantsService } from '../tenancy/tenants.service';

/** Mes actual en hora de Lima (YYYY-MM). */
export function limaMonth(d = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Lima' }).slice(0, 7);
}

/**
 * Cobro mensual por registro monitoreado: el día 1 se cuenta la cartera monitoreada de
 * cada cliente. Es idempotente por cliente y mes (plaft_billing_runs).
 */
@Injectable()
export class PlaftBillingService {
  private readonly logger = new Logger(PlaftBillingService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly tenants: TenantsService,
    private readonly audit: AuditService,
  ) {}

  async recordMonitored(month: string) {
    // Se registra al inicio del mes (hora de Lima) para que caiga en el estado de cuenta de ese mes.
    const at = new Date(`${month}-01T00:00:00-05:00`);
    const out: { tenant_id: string; month: string; monitored: number; recorded: boolean }[] = [];
    for (const tenant of await this.tenants.listActive('plaft')) {
      out.push(
        await this.db.withTenant(tenant.id, async (db) => {
          const run = await one<{ monitored: number }>(
            db,
            `INSERT INTO plaft_billing_runs (tenant_id, month, monitored)
             SELECT $1, $2, count(*)::int FROM plaft_subjects WHERE monitor
             ON CONFLICT (tenant_id, month) DO NOTHING RETURNING monitored`,
            [tenant.id, month],
          );
          if (!run) {
            const prev = await one<{ monitored: number }>(db, 'SELECT monitored FROM plaft_billing_runs WHERE month = $1', [month]);
            return { tenant_id: tenant.id, month, monitored: prev!.monitored, recorded: false };
          }
          if (run.monitored > 0) {
            await db.query(
              `INSERT INTO usage_events (tenant_id, at, service, unit, quantity, ref)
               VALUES ($1,$2,'plaft','monitored_record_month',$3,$4)`,
              [tenant.id, at, run.monitored, `monitored:${month}`],
            );
          }
          await this.audit.record(db, tenant.id, {
            actor: 'system:billing',
            action: 'plaft.monitored_billed',
            entity: 'plaft_portfolio',
            data: { month, monitored: run.monitored },
          });
          return { tenant_id: tenant.id, month, monitored: run.monitored, recorded: true };
        }),
      );
    }
    return out;
  }

  @Cron('0 3 1 * *', { name: 'plaft-monitored-billing', timeZone: 'America/Lima' })
  async monthly() {
    if (!this.config.jobsEnabled) return;
    const month = limaMonth();
    const res = await this.recordMonitored(month);
    this.logger.log(`Cobro de monitoreo ${month}: ${res.filter((r) => r.recorded).length} clientes`);
  }
}
