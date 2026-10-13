import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { Actor } from '../common/actor';
import { ApiKeyGuard, CurrentTenant, RequireModule } from '../tenancy/guards';
import { Tenant } from '../tenancy/tenant';
import {
  CreateTaskDto,
  CsvImportDto,
  MatrixQueryDto,
  NormsQueryDto,
  ProcessDto,
  TasksQueryDto,
  UpdateImpactDto,
  UpdateProcessDto,
  UpdateTaskDto,
} from './dto';
import { ImpactsService, limaToday } from './impacts.service';
import { NormsService } from './norms.service';
import { ProcessesService } from './processes.service';
import { TasksService } from './tasks.service';

@Controller('v1/regulatory')
@UseGuards(ApiKeyGuard)
@RequireModule('regulatory')
export class RegulatoryController {
  constructor(
    private readonly norms: NormsService,
    private readonly impacts: ImpactsService,
    private readonly processes: ProcessesService,
    private readonly tasks: TasksService,
  ) {}

  @Get('digest')
  digest(@CurrentTenant() t: Tenant, @Query('date') date?: string) {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('date debe ser YYYY-MM-DD');
    return this.impacts.digest(t, date ?? limaToday());
  }

  @Get('norms')
  listNorms(@Query() q: NormsQueryDto) {
    return this.norms.list(q);
  }

  @Get('norms/:id')
  async getNorm(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const norm = await this.norms.get(id);
    return { ...norm, impacts: await this.impacts.listForNorm(t, id) };
  }

  @Post('norms/:id/comment-draft')
  async commentDraft(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Actor() actor: string) {
    return this.impacts.commentDraft(t, await this.norms.get(id), actor);
  }

  @Get('impact-matrix')
  async matrix(@CurrentTenant() t: Tenant, @Query() q: MatrixQueryDto, @Res({ passthrough: true }) res: Response) {
    const rows = await this.impacts.matrix(t, q);
    if (q.format !== 'csv') return rows;
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="matriz-impacto.csv"');
    return this.impacts.matrixCsv(rows);
  }

  @Patch('impacts/:id')
  updateImpact(
    @CurrentTenant() t: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateImpactDto,
    @Actor() actor: string,
  ) {
    return this.impacts.updateStatus(t, id, dto, actor);
  }

  @Post('impacts/recompute')
  async recompute(@CurrentTenant() t: Tenant) {
    return { impacts: await this.impacts.recomputeTenant(t) };
  }

  @Get('processes')
  listProcesses(@CurrentTenant() t: Tenant) {
    return this.processes.list(t);
  }

  @Post('processes')
  createProcess(@CurrentTenant() t: Tenant, @Body() dto: ProcessDto, @Actor() actor: string) {
    return this.processes.create(t, dto, actor);
  }

  @Post('processes/import')
  importProcesses(@CurrentTenant() t: Tenant, @Body() dto: CsvImportDto, @Actor() actor: string) {
    return this.processes.importCsv(t, dto.csv, actor);
  }

  @Patch('processes/:id')
  updateProcess(
    @CurrentTenant() t: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProcessDto,
    @Actor() actor: string,
  ) {
    return this.processes.update(t, id, dto, actor);
  }

  @Delete('processes/:id')
  deleteProcess(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Actor() actor: string) {
    return this.processes.remove(t, id, actor);
  }

  @Get('tasks')
  listTasks(@CurrentTenant() t: Tenant, @Query() q: TasksQueryDto) {
    return this.tasks.list(t, q);
  }

  @Get('tasks/overdue')
  overdueTasks(@CurrentTenant() t: Tenant) {
    return this.tasks.list(t, { overdue: 'true' });
  }

  @Post('tasks')
  createTask(@CurrentTenant() t: Tenant, @Body() dto: CreateTaskDto, @Actor() actor: string) {
    return this.tasks.create(t, dto, actor);
  }

  @Patch('tasks/:id')
  updateTask(
    @CurrentTenant() t: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskDto,
    @Actor() actor: string,
  ) {
    return this.tasks.update(t, id, dto, actor);
  }

  @Delete('tasks/:id')
  deleteTask(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Actor() actor: string) {
    return this.tasks.remove(t, id, actor);
  }
}
