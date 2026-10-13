import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadConfig } from './config/config';

async function main() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), { rawBody: true });
  configureApp(app);
  await app.listen(config.port);
  console.log(`Ukuk API escuchando en :${config.port}`);
}

main();
