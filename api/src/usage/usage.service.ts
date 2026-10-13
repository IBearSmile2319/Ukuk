import { Injectable } from '@nestjs/common';
import { DbService, Queryable, many } from '../db/db.service';
import { ServiceModule, Tenant } from '../tenancy/tenant';
import { MonthlyStatement, computeStatement } from './pricing';

@Injectable()
export class UsageService {
  constructor(private readonly db: DbService) {}

  /** Registrar dentro de la transacción del caso de uso (withTenant). */
  async record(
    db: Queryable,
    tenantId: string,
    service: ServiceModule,
    unit: string,
    quantity = 1,
    ref?: string,
  ): Promise<void> {
    await db.query(
      'INSERT INTO usage_events (tenant_id, service, unit, quantity, ref) VALUES ($1,$2,$3,$4,$5)',
      [tenantId, service, unit, quantity, ref ?? null],
    );
  }

  /** month: 'YYYY-MM' */
  async statement(tenant: Tenant, month: string): Promise<MonthlyStatement & { month: string }> {
    const start = new Date(`${month}-01T00:00:00-05:00`);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    const usage = await this.db.withTenant(tenant.id, (db) =>
      many(
        db,
        `SELECT service, unit, sum(quantity)::float AS quantity FROM usage_events
          WHERE at >= $1 AND at < $2 GROUP BY service, unit`,
        [start, end],
      ),
    );
    const statement = computeStatement(tenant.modules, usage, {
      regulatoryPlan: tenant.settings.regulatory_plan as string | undefined,
    });
    return { month, ...statement };
  }
}
