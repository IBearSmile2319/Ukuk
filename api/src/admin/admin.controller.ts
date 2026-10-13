import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ArrayUnique, IsArray, IsIn, IsObject, IsOptional, IsString, Length, Matches } from 'class-validator';
import { AdminGuard } from '../tenancy/guards';
import { ENTITY_TYPES, EntityType, SERVICE_MODULES, ServiceModule } from '../tenancy/tenant';
import { TenantsService } from '../tenancy/tenants.service';

class CreateTenantDto {
  @IsString() @Length(2, 200) name: string;
  @IsOptional() @Matches(/^\d{11}$/) ruc?: string;
  @IsIn(ENTITY_TYPES) entityType: EntityType;
  @IsOptional() @IsArray() @IsString({ each: true }) businessLines?: string[];
  @IsArray() @ArrayUnique() @IsIn(SERVICE_MODULES, { each: true }) modules: ServiceModule[];
  @IsOptional() @IsObject() settings?: Record<string, unknown>;
}

class UpdateTenantDto {
  @IsOptional() @IsIn(ENTITY_TYPES) entityType?: EntityType;
  @IsOptional() @IsArray() @IsString({ each: true }) businessLines?: string[];
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(SERVICE_MODULES, { each: true }) modules?: ServiceModule[];
  @IsOptional() @IsObject() settings?: Record<string, unknown>;
}

class CreateKeyDto {
  @IsString() @Length(1, 100) name: string;
}

const publicTenant = ({ dataKeyEnc, ...t }: Awaited<ReturnType<TenantsService['get']>>) => t;

/** Alta de clientes y llaves. Lo usa el equipo de Ukuk, no los clientes. */
@Controller('admin/tenants')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly tenants: TenantsService) {}

  @Post()
  async create(@Body() dto: CreateTenantDto) {
    return publicTenant(await this.tenants.create(dto));
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return publicTenant(await this.tenants.get(id));
  }

  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTenantDto) {
    return publicTenant(await this.tenants.update(id, dto));
  }

  @Post(':id/api-keys')
  createKey(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateKeyDto) {
    return this.tenants.createApiKey(id, dto.name);
  }

  @Delete(':id/api-keys/:keyId')
  async revokeKey(@Param('id', ParseUUIDPipe) id: string, @Param('keyId', ParseUUIDPipe) keyId: string) {
    await this.tenants.revokeApiKey(id, keyId);
    return { revoked: true };
  }
}
