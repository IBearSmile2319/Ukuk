import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Inject, Logger, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../config/config';
import { ConversationService } from './conversation.service';
import { verifyMetaSignature } from './webhook-signature';

/** Webhook público de la Cloud API de WhatsApp (un solo endpoint para todas las aseguradoras). */
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly conversations: ConversationService,
  ) {}

  @Get()
  verify(@Query('hub.mode') mode?: string, @Query('hub.verify_token') token?: string, @Query('hub.challenge') challenge?: string) {
    if (mode === 'subscribe' && this.config.whatsapp.verifyToken && token === this.config.whatsapp.verifyToken && challenge) {
      return challenge;
    }
    throw new ForbiddenException('Verificación inválida');
  }

  @Post()
  @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature: string | undefined, @Body() body: unknown) {
    if (!verifyMetaSignature(this.config.whatsapp.appSecret, req.rawBody, signature)) {
      this.logger.warn('Webhook de WhatsApp con firma inválida');
      throw new UnauthorizedException('Firma inválida');
    }
    // Se responde de inmediato; Meta reintenta si tardamos y la deduplicación cubre los reintentos.
    const queued = this.conversations.enqueue(body);
    return { received: true, queued };
  }
}
