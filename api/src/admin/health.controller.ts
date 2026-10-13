import { Controller, Get } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { EngineClient } from '../engine/engine.client';

@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly engine: EngineClient,
  ) {}

  @Get()
  async health() {
    const db = await this.db.query('SELECT 1').then(() => 'ok', () => 'error');
    const engine = await this.engine.health().then((h) => h.version, () => 'error');
    return { status: db === 'ok' && engine !== 'error' ? 'ok' : 'degraded', db, engine };
  }
}
