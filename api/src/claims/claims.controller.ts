import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Actor } from '../common/actor';
import { ApiKeyGuard, CurrentTenant, RequireModule } from '../tenancy/guards';
import { Tenant } from '../tenancy/tenant';
import { ClaimsService } from './claims.service';
import { ClaimsConfigDto, ClaimsQueryDto, DecisionDto, PolicyImportDto, ReviewDto } from './dto';

@Controller('v1/claims')
@UseGuards(ApiKeyGuard)
@RequireModule('claims')
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Get()
  list(@CurrentTenant() t: Tenant, @Query() q: ClaimsQueryDto) {
    return this.claims.list(t, q);
  }

  @Get('alerts')
  alerts(@CurrentTenant() t: Tenant) {
    return this.claims.alerts(t);
  }

  @Get('config')
  getConfig(@CurrentTenant() t: Tenant) {
    return this.claims.getConfig(t);
  }

  @Put('config')
  putConfig(@CurrentTenant() t: Tenant, @Body() dto: ClaimsConfigDto, @Actor() actor: string) {
    return this.claims.putConfig(t, dto, actor);
  }

  @Post('policies/import')
  importPolicies(@CurrentTenant() t: Tenant, @Body() dto: PolicyImportDto, @Actor() actor: string) {
    return this.claims.importPolicies(t, dto.csv, dto.replace ?? false, actor);
  }

  @Get(':id')
  get(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.claims.get(t, id);
  }

  @Get(':id/files/:fileId')
  async file(
    @CurrentTenant() t: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { meta, data } = await this.claims.file(t, id, fileId);
    res.setHeader('content-type', meta.mimeType);
    res.setHeader('cache-control', 'no-store');
    return new StreamableFile(data);
  }

  @Post(':id/review')
  review(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewDto, @Actor() actor: string) {
    return this.claims.review(t, id, dto, actor);
  }

  @Post(':id/decision')
  decide(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto, @Actor() actor: string) {
    return this.claims.decide(t, id, dto, actor);
  }

  @Post(':id/documents-complete')
  documentsComplete(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Actor() actor: string) {
    return this.claims.documentsComplete(t, id, actor);
  }
}
