import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { rateLimit } from './common/rate-limit';

/** Configuración común a main.ts y a los tests e2e. */
export function configureApp(app: INestApplication) {
  const express = app as NestExpressApplication;
  // rawBody: la firma de los webhooks de WhatsApp se calcula sobre el cuerpo exacto.
  express.useBodyParser('json', { limit: '30mb' });
  // Detrás de Caddy (red privada de Docker) la IP real llega en X-Forwarded-For.
  express.set('trust proxy', 'loopback, linklocal, uniquelocal');
  express.use(['/public', '/capture'], rateLimit(30, 60_000));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.enableShutdownHooks();
}
