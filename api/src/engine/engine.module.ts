import { Global, Module } from '@nestjs/common';
import { EngineClient } from './engine.client';

@Global()
@Module({ providers: [EngineClient], exports: [EngineClient] })
export class EngineModule {}
