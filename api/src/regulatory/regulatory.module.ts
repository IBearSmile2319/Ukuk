import { Module } from '@nestjs/common';
import { AdminRegulatoryController } from './admin-regulatory.controller';
import { ImpactsService } from './impacts.service';
import { RegulatoryIngestService } from './ingest.service';
import { NormsService } from './norms.service';
import { ProcessesService } from './processes.service';
import { RegulatoryController } from './regulatory.controller';
import { ElPeruanoAdapter } from './sources/el-peruano.adapter';
import { SbsAdapter } from './sources/sbs.adapter';
import { PoliteFetcher, SOURCE_ADAPTERS, SourceAdapter, enabledSources } from './sources/source-adapter';
import { TasksService } from './tasks.service';

@Module({
  controllers: [RegulatoryController, AdminRegulatoryController],
  providers: [
    NormsService,
    ImpactsService,
    ProcessesService,
    TasksService,
    RegulatoryIngestService,
    {
      provide: SOURCE_ADAPTERS,
      useFactory: (): SourceAdapter[] => {
        const http = new PoliteFetcher();
        const all: SourceAdapter[] = [new ElPeruanoAdapter(http), new SbsAdapter(http)];
        const enabled = enabledSources();
        return all.filter((a) => enabled.includes(a.source));
      },
    },
  ],
  exports: [NormsService, ImpactsService],
})
export class RegulatoryModule {}
