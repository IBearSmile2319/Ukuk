import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { APP_CONFIG, AppConfig } from '../config/config';
import { limaToday } from './impacts.service';
import { NormsService, rawToInput } from './norms.service';
import { SOURCE_ADAPTERS, SourceAdapter } from './sources/source-adapter';
import { addDays } from './text';

/** Corre los adaptadores habilitados y pasa lo obtenido por la ingesta normal. */
@Injectable()
export class RegulatoryIngestService {
  private readonly logger = new Logger(RegulatoryIngestService.name);
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SOURCE_ADAPTERS) private readonly adapters: SourceAdapter[],
    private readonly norms: NormsService,
  ) {}

  async run(since = addDays(limaToday(), -1)) {
    if (this.running) return { skipped: true, reason: 'ya hay una ingesta en curso' };
    this.running = true;
    try {
      const report: { source: string; fetched: number; ingested: number; error?: string }[] = [];
      for (const adapter of this.adapters) {
        try {
          const raw = await adapter.fetchSince(since);
          const res = raw.length ? await this.norms.ingest(raw.map(rawToInput)) : [];
          report.push({ source: adapter.source, fetched: raw.length, ingested: res.length });
        } catch (err) {
          this.logger.error(`Fuente ${adapter.source}: ${(err as Error).message}`);
          report.push({ source: adapter.source, fetched: 0, ingested: 0, error: (err as Error).message });
        }
      }
      return { since, sources: report };
    } finally {
      this.running = false;
    }
  }

  @Cron('0 7 * * *', { name: 'regulatory-ingest', timeZone: 'America/Lima' })
  async daily() {
    if (!this.config.jobsEnabled || !this.adapters.length) return;
    const r = await this.run();
    this.logger.log(`Ingesta diaria: ${JSON.stringify(r)}`);
  }
}
