import { Module } from '@nestjs/common';
import { AdminClaimsController } from './admin-claims.controller';
import { CaptureController } from './capture.controller';
import { CaptureService } from './capture.service';
import { ClaimFilesService } from './claim-files.service';
import { ClaimsController } from './claims.controller';
import { ClaimsJobs } from './claims.jobs';
import { ClaimsService } from './claims.service';
import { ConversationService } from './conversation.service';
import { CLAIM_MAILER, ClaimDispatcher, LoggerMailer, NoopTranscriber, TRANSCRIBER } from './destination';
import { CsvPolicyProvider } from './policy-provider';
import { WaMessenger } from './wa-messenger.service';
import { WhatsAppWebhookController } from './webhook.controller';
import { GraphWhatsAppClient, WHATSAPP_CLIENT } from './whatsapp.client';

@Module({
  controllers: [ClaimsController, WhatsAppWebhookController, CaptureController, AdminClaimsController],
  providers: [
    ClaimsService,
    ClaimFilesService,
    ConversationService,
    CaptureService,
    ClaimDispatcher,
    CsvPolicyProvider,
    WaMessenger,
    ClaimsJobs,
    { provide: WHATSAPP_CLIENT, useClass: GraphWhatsAppClient },
    { provide: CLAIM_MAILER, useClass: LoggerMailer },
    { provide: TRANSCRIBER, useClass: NoopTranscriber },
  ],
  exports: [ClaimsService, ConversationService],
})
export class ClaimsModule {}
