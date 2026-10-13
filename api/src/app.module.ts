import { DynamicModule, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { ClaimsModule } from './claims/claims.module';
import { APP_CONFIG, AppConfig, loadConfig } from './config/config';
import { CryptoModule } from './crypto/crypto.module';
import { DbModule } from './db/db.module';
import { DocumentsModule } from './documents/documents.module';
import { EngineModule } from './engine/engine.module';
import { LlmModule } from './llm/llm.module';
import { PlaftModule } from './plaft/plaft.module';
import { RegulatoryModule } from './regulatory/regulatory.module';
import { StorageModule } from './storage/storage.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { UsageModule } from './usage/usage.module';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig = loadConfig()): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        ...(config.jobsEnabled ? [ScheduleModule.forRoot()] : []),
        DbModule,
        CryptoModule,
        TenancyModule,
        AuditModule,
        UsageModule,
        StorageModule,
        EngineModule,
        LlmModule,
        AdminModule,
        DocumentsModule,
        RegulatoryModule,
        PlaftModule,
        ClaimsModule,
      ],
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
