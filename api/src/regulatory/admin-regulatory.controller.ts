import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../tenancy/guards';
import { IngestNormsDto, RunIngestDto } from './dto';
import { RegulatoryIngestService } from './ingest.service';
import { NormsService } from './norms.service';

/** Ingesta de normas (globales). Lo usa el equipo de Ukuk. */
@Controller('admin/regulatory')
@UseGuards(AdminGuard)
export class AdminRegulatoryController {
  constructor(
    private readonly norms: NormsService,
    private readonly ingest: RegulatoryIngestService,
  ) {}

  @Post('norms')
  ingestNorms(@Body() dto: IngestNormsDto) {
    return this.norms.ingest(dto.norms);
  }

  @Post('ingest')
  @HttpCode(200)
  run(@Body() dto: RunIngestDto) {
    return this.ingest.run(dto.since);
  }
}
