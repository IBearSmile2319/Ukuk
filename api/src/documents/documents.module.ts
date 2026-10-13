import { Module } from '@nestjs/common';
import { DocumentsController, TemplatesController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { OCR_PROVIDER } from './ocr/ocr.provider';
import { ocrProviderFromEnv } from './ocr/textract.provider';
import { TemplatesService } from './templates.service';
import { EXTERNAL_VALIDATORS } from './validators/external-validator';
import { ReniecValidator } from './validators/reniec.validator';
import { RucValidator } from './validators/ruc.validator';
import { SunatCpeValidator } from './validators/sunat.validator';

/** Servicio 1: verificación documental antifraude. */
@Module({
  // El orden importa: /v1/documents/templates debe registrarse antes que /v1/documents/:id.
  controllers: [TemplatesController, DocumentsController],
  providers: [
    DocumentsService,
    TemplatesService,
    SunatCpeValidator,
    ReniecValidator,
    RucValidator,
    { provide: OCR_PROVIDER, useFactory: () => ocrProviderFromEnv() },
    {
      provide: EXTERNAL_VALIDATORS,
      inject: [SunatCpeValidator, ReniecValidator, RucValidator],
      useFactory: (...validators: unknown[]) => validators,
    },
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
