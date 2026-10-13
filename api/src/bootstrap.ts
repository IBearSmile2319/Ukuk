import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';

/** Configuración común a main.ts y a los tests e2e. */
export function configureApp(app: INestApplication) {
  const express = app as NestExpressApplication;
  // rawBody: la firma de los webhooks de WhatsApp se calcula sobre el cuerpo exacto.
  express.useBodyParser('json', { limit: '30mb' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.enableShutdownHooks();
}
