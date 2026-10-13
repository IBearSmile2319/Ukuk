import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiKeyGuard, CurrentTenant, RequireModule } from '../tenancy/guards';
import { Tenant } from '../tenancy/tenant';
import { CasesService } from './cases.service';
import {
  BulkSubjectsDto,
  CreateSubjectDto,
  DecisionDto,
  ListCasesQuery,
  ListSubjectsQuery,
  ReportQuery,
  actorOf,
} from './dto';
import { ScreeningService } from './screening.service';
import { SubjectsService } from './subjects.service';

const MAX_CSV_BYTES = 20 * 1024 * 1024;

@Controller('v1/plaft')
@UseGuards(ApiKeyGuard)
@RequireModule('plaft')
export class PlaftController {
  constructor(
    private readonly subjects: SubjectsService,
    private readonly cases: CasesService,
    private readonly screening: ScreeningService,
  ) {}

  @Post('subjects')
  create(@CurrentTenant() t: Tenant, @Body() dto: CreateSubjectDto) {
    return this.subjects.create(t, dto, actorOf(dto.analyst));
  }

  @Post('subjects/bulk')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_CSV_BYTES, files: 1 } }))
  bulk(@CurrentTenant() t: Tenant, @UploadedFile() file: { buffer: Buffer } | undefined, @Body() dto: BulkSubjectsDto) {
    return this.subjects.bulk(t, file?.buffer, dto.monitor ?? true, actorOf(dto.analyst));
  }

  @Get('subjects')
  list(@CurrentTenant() t: Tenant, @Query() q: ListSubjectsQuery) {
    return this.subjects.list(t, q);
  }

  @Get('subjects/:id')
  get(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.subjects.get(t, id);
  }

  @Get('cases')
  listCases(@CurrentTenant() t: Tenant, @Query() q: ListCasesQuery) {
    return this.cases.list(t, q);
  }

  @Get('cases/:id')
  getCase(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.cases.get(t, id);
  }

  @Post('cases/:id/decision')
  decide(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) {
    return this.cases.decide(t, id, dto, actorOf(dto.analyst));
  }

  /** El cliente revisa su propia cartera monitoreada contra las listas cargadas hoy. */
  @Post('rescreen')
  rescreen(@CurrentTenant() t: Tenant) {
    return this.screening.rescreenTenant(t, 'api');
  }

  @Get('report')
  report(@CurrentTenant() t: Tenant, @Query() q: ReportQuery) {
    return this.subjects.report(t, q);
  }
}
