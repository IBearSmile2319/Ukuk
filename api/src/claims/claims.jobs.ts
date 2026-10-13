import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { APP_CONFIG, AppConfig } from '../config/config';
import { TenantsService } from '../tenancy/tenants.service';
import { ClaimsService } from './claims.service';

/** Barrido horario del reloj legal: alertas de los días 20/25/28 y consentimientos. */
@Injectable()
export class ClaimsJobs {
  private readonly logger = new Logger(ClaimsJobs.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly tenants: TenantsService,
    private readonly claims: ClaimsService,
  ) {}

  @Cron('0 * * * *', { name: 'claims-deadlines', timeZone: 'America/Lima' })
  async hourly() {
    if (!this.config.jobsEnabled) return;
    for (const t of await this.tenants.listActive('claims')) {
      try {
        const r = await this.claims.sweepTenant(t);
        if (r.alerts || r.consented) this.logger.log(`Cliente ${t.id}: ${r.alerts} alertas, ${r.consented} consentidos`);
      } catch (err) {
        this.logger.error(`Barrido de plazos del cliente ${t.id}: ${(err as Error).message}`);
      }
    }
  }
}
