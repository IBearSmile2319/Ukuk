import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBase64, IsIn, IsLatitude, IsLongitude, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { DbService, many, one } from '../db/db.service';
import { ApiKeyGuard, CurrentTenant, RequireModule } from '../tenancy/guards';
import { Tenant } from '../tenancy/tenant';
import { Inbound } from './conversation';
import { ConversationService } from './conversation.service';
import { WaInboundMessage } from './whatsapp-payload';
import { SANDBOX_PREFIX, sandboxMedia } from './whatsapp.client';

class SimLocationDto {
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
  @IsOptional() @IsString() @MaxLength(200) name?: string;
}

class SimMediaDto {
  @IsIn(['image', 'document']) kind: 'image' | 'document';
  @IsString() @MaxLength(100) mime_type: string;
  // ~5 MB en base64, el límite de imágenes de WhatsApp.
  @IsBase64() @MaxLength(7_000_000) data_base64: string;
  @IsOptional() @IsString() @MaxLength(200) filename?: string;
}

class SimMessageDto {
  @Matches(/^\d{8,15}$/) from: string;
  @IsOptional() @IsString() @MaxLength(60) name?: string;
  @IsOptional() @IsString() @MaxLength(4096) text?: string;
  /** id de un botón o fila de lista que envió el bot. */
  @IsOptional() @IsString() @MaxLength(200) reply_id?: string;
  @IsOptional() @IsString() @MaxLength(100) reply_title?: string;
  @IsOptional() @ValidateNested() @Type(() => SimLocationDto) location?: SimLocationDto;
  @IsOptional() @ValidateNested() @Type(() => SimMediaDto) media?: SimMediaDto;
}

function toInbound(dto: SimMessageDto): Pick<WaInboundMessage, 'type' | 'body' | 'input' | 'media'> {
  if (dto.media) {
    const id = `sim-media-${randomUUID()}`;
    sandboxMedia.set(id, { data: Buffer.from(dto.media.data_base64, 'base64'), mimeType: dto.media.mime_type });
    const input: Inbound = { kind: 'media', media: dto.media.kind, fileId: '', mimeType: dto.media.mime_type };
    return { type: dto.media.kind, body: dto.media.filename ?? null, input, media: { id, kind: dto.media.kind, mimeType: dto.media.mime_type, filename: dto.media.filename } };
  }
  if (dto.location) {
    const { lat, lng, name } = dto.location;
    return { type: 'location', body: name ?? `${lat},${lng}`, input: { kind: 'location', lat, lng, name } };
  }
  if (dto.reply_id) {
    const title = dto.reply_title ?? dto.reply_id;
    return { type: 'interactive', body: title, input: { kind: 'reply', id: dto.reply_id, title } };
  }
  const text = dto.text ?? '';
  return { type: 'text', body: text, input: { kind: 'text', text } };
}

/**
 * Simulador de WhatsApp para probar y hacer demos sin una cuenta de Meta. Usa un
 * número de prueba por cliente (`sandbox-<tenant>`) que no envía nada a Graph; el
 * resto del flujo (estados, plazos, captura de fotos, casos) es el real.
 * Debe registrarse antes que ClaimsController, cuyo `GET :id` capturaría esta ruta.
 */
@Controller('v1/claims/simulator')
@UseGuards(ApiKeyGuard)
@RequireModule('claims')
export class ClaimsSimulatorController {
  constructor(
    private readonly db: DbService,
    private readonly conversations: ConversationService,
  ) {}

  @Post()
  async send(@CurrentTenant() t: Tenant, @Body() dto: SimMessageDto) {
    const phoneNumberId = `${SANDBOX_PREFIX}${t.id}`;
    await this.db.query(
      `INSERT INTO wa_numbers (phone_number_id, tenant_id, display_number, active)
       VALUES ($1,$2,'Simulador',true) ON CONFLICT (phone_number_id) DO NOTHING`,
      [phoneNumberId, t.id],
    );
    await this.conversations.handle({
      phoneNumberId,
      from: dto.from,
      profileName: dto.name,
      wamid: `sim.${randomUUID()}`,
      timestamp: new Date(),
      ...toInbound(dto),
    });
    return this.transcript(t, dto.from);
  }

  /** Conversación más reciente de ese número con el simulador. */
  @Get()
  transcript(@CurrentTenant() t: Tenant, @Query('from') from: string) {
    return this.db.withTenant(t.id, async (db) => {
      const conversation = await one(
        db,
        `SELECT id, status, claim_id, message_count FROM claim_conversations
          WHERE phone_number_id = $1 AND wa_id = $2 ORDER BY last_message_at DESC LIMIT 1`,
        [`${SANDBOX_PREFIX}${t.id}`, String(from ?? '')],
      );
      const messages = conversation
        ? await many(
            db,
            'SELECT id, direction, type, body, payload, file_id, at FROM claim_messages WHERE conversation_id = $1 ORDER BY id',
            [conversation.id],
          )
        : [];
      return { conversation: conversation ?? null, messages };
    });
  }
}
