import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { AdminGuard } from '../tenancy/guards';
import { TenantsService } from '../tenancy/tenants.service';
import { WhatsAppNumberDto } from './dto';
import { WaMessenger } from './wa-messenger.service';

/** Alta del número de WhatsApp Business de cada aseguradora. */
@Controller('admin/claims')
@UseGuards(AdminGuard)
export class AdminClaimsController {
  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantsService,
    private readonly messenger: WaMessenger,
    private readonly audit: AuditService,
  ) {}

  @Post('whatsapp-numbers')
  async bind(@Body() dto: WhatsAppNumberDto) {
    const tenant = await this.tenants.get(dto.tenant_id);
    if (!tenant.modules.includes('claims')) throw new BadRequestException('El cliente no tiene activo el servicio de siniestros');
    const existing = await this.messenger.number(dto.phone_number_id);
    if (existing && existing.tenant_id !== tenant.id) throw new BadRequestException('El número ya está asignado a otro cliente');
    const enc = dto.access_token ? this.messenger.sealToken(tenant, dto.phone_number_id, dto.access_token) : null;
    await this.db.query(
      `INSERT INTO wa_numbers (phone_number_id, tenant_id, display_number, access_token_enc, secret_ref, active)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (phone_number_id) DO UPDATE SET display_number = EXCLUDED.display_number,
         access_token_enc = COALESCE(EXCLUDED.access_token_enc, wa_numbers.access_token_enc),
         secret_ref = COALESCE(EXCLUDED.secret_ref, wa_numbers.secret_ref), active = EXCLUDED.active`,
      [dto.phone_number_id, tenant.id, dto.display_number, enc, dto.secret_ref ?? null, dto.active ?? true],
    );
    await this.db.withTenant(tenant.id, (db) =>
      this.audit.record(db, tenant.id, {
        actor: 'admin',
        action: 'claims.whatsapp_number_bound',
        entity: 'wa_number',
        entityId: dto.phone_number_id,
        data: { display_number: dto.display_number, token: enc ? 'cifrado' : dto.secret_ref ? `secreto:${dto.secret_ref}` : 'global' },
      }),
    );
    return { phone_number_id: dto.phone_number_id, tenant_id: tenant.id, display_number: dto.display_number, active: dto.active ?? true };
  }
}
