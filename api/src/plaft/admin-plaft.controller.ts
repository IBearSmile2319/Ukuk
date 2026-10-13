import {
  BadRequestException,
  Controller,
  Get,
  Param,
  PayloadTooLargeException,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminGuard } from '../tenancy/guards';
import { PlaftBillingService } from './billing.service';
import { BillingQuery, SyncQuery, WatchlistUploadQuery } from './dto';
import { WatchlistSyncService } from './watchlist-sync.service';

const MAX_LIST_BYTES = 200 * 1024 * 1024;

/** Lee el cuerpo crudo (CSV, XML o JSONL) sin pasar por el parser JSON. */
async function readRaw(req: Request & { rawBody?: Buffer }): Promise<Buffer> {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_LIST_BYTES) throw new PayloadTooLargeException('La lista supera 200 MB');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Listas de vigilancia (compartidas por todos los clientes) y cobro mensual. Solo el equipo de Ukuk. */
@Controller('admin/plaft')
@UseGuards(AdminGuard)
export class AdminPlaftController {
  constructor(
    private readonly sync: WatchlistSyncService,
    private readonly billing: PlaftBillingService,
  ) {}

  @Get('watchlists')
  versions() {
    return this.sync.listVersions();
  }

  @Post('watchlists/sync')
  syncAll(@Query() q: SyncQuery) {
    return this.sync.syncAll({ rescreen: q.rescreen ?? true });
  }

  /** Carga manual: p. ej. la base PEP Perú (`ukuk_jsonl`) armada con El Peruano, Infogob y Contraloría. */
  @Put('watchlists/:source')
  async upload(@Param('source') source: string, @Query() q: WatchlistUploadQuery, @Req() req: Request) {
    if (!/^[a-z0-9_-]{1,40}$/.test(source)) {
      throw new BadRequestException('source debe tener entre 1 y 40 caracteres [a-z0-9_-]');
    }
    const data = await readRaw(req);
    if (!data.length) throw new BadRequestException('Envíe el archivo de la lista en el cuerpo');
    const result = await this.sync.load(source, q.format, q.category ?? 'sanction', data);
    const rescreen = q.rescreen && result.changed ? await this.sync.rescreenAll() : null;
    return { ...result, rescreen };
  }

  @Post('billing/monitored')
  monitored(@Query() q: BillingQuery) {
    return this.billing.recordMonitored(q.month);
  }
}
