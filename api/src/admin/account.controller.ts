import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ApiKeyGuard, CurrentTenant } from '../tenancy/guards';
import { Tenant } from '../tenancy/tenant';
import { UsageService } from '../usage/usage.service';

/** Lo que cada cliente puede ver de su propia cuenta. */
@Controller('v1/account')
@UseGuards(ApiKeyGuard)
export class AccountController {
  constructor(
    private readonly usage: UsageService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  me(@CurrentTenant() t: Tenant) {
    return { id: t.id, name: t.name, entityType: t.entityType, modules: t.modules, businessLines: t.businessLines };
  }

  @Get('usage')
  statement(@CurrentTenant() t: Tenant, @Query('month') month?: string) {
    const m = month ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) throw new BadRequestException('month debe ser YYYY-MM');
    return this.usage.statement(t, m);
  }

  @Get('audit')
  auditLog(
    @CurrentTenant() t: Tenant,
    @Query('entity') entity?: string,
    @Query('entity_id') entityId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.audit.list(t.id, { entity, entityId, limit: limit ? Number(limit) : undefined });
  }

  @Get('audit/verify')
  verify(@CurrentTenant() t: Tenant) {
    return this.audit.verify(t.id);
  }
}
