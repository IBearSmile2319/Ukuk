import { Body, Controller, Get, HttpCode, Logger, Post, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { DbService } from '../db/db.service';
import { AdminGuard } from '../tenancy/guards';
import { ENTITY_TYPES, SERVICE_MODULES } from '../tenancy/tenant';

class LeadDto {
  @IsString() @Length(2, 120) name: string;
  @IsString() @Length(2, 200) company: string;
  @IsEmail() email: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsIn(ENTITY_TYPES) entity_type?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(4) @IsIn(SERVICE_MODULES, { each: true }) services?: string[];
  @IsOptional() @IsString() @MaxLength(2000) message?: string;
  /** Trampa para bots: un humano nunca lo llena (está oculto en el formulario). */
  @IsOptional() @IsString() website?: string;
}

// ponytail: sin límite de tasa; agregar uno (o un captcha) si llega spam.
@Controller()
export class LeadsController {
  private readonly logger = new Logger(LeadsController.name);

  constructor(private readonly db: DbService) {}

  @Post('public/leads')
  @HttpCode(201)
  async create(@Body() dto: LeadDto) {
    if (dto.website) return { ok: true };
    await this.db.query(
      `INSERT INTO leads (name, company, email, phone, entity_type, services, message) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [dto.name, dto.company, dto.email, dto.phone ?? null, dto.entity_type ?? null, dto.services ?? [], dto.message ?? null],
    );
    this.logger.log(`Nuevo interesado: ${dto.company}`);
    return { ok: true };
  }

  @Get('admin/leads')
  @UseGuards(AdminGuard)
  list() {
    return this.db.query('SELECT * FROM leads ORDER BY created_at DESC LIMIT 500');
  }
}
