import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadConfig } from './config/config';

async function main() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), { rawBody: true });
  configureApp(app);
  // La web (landing + portal) se sirve desde la misma API: un solo despliegue.
  const webDir = resolve(process.env.UKUK_WEB_DIR ?? '../web/dist');
  if (existsSync(webDir)) app.useStaticAssets(webDir);
  await app.listen(config.port);
  console.log(`Ukuk API escuchando en :${config.port}`);
}

main();
