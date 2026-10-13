import { Module } from '@nestjs/common';
import { ADVERSE_MEDIA_PROVIDER, AdverseMediaService, StubAdverseMediaProvider } from './adverse-media';
import { AdminPlaftController } from './admin-plaft.controller';
import { PlaftBillingService } from './billing.service';
import { CasesService } from './cases.service';
import { PlaftController } from './plaft.controller';
import { ScreeningService } from './screening.service';
import { SubjectsService } from './subjects.service';
import {
  WATCHLIST_FETCHER,
  WATCHLIST_SOURCES,
  WatchlistSyncService,
  httpFetcher,
  watchlistSourcesFromEnv,
} from './watchlist-sync.service';

/** Servicio 3: PLAFT (listas, debida diligencia, casos y monitoreo de cartera). */
@Module({
  controllers: [PlaftController, AdminPlaftController],
  providers: [
    ScreeningService,
    SubjectsService,
    CasesService,
    AdverseMediaService,
    WatchlistSyncService,
    PlaftBillingService,
    { provide: ADVERSE_MEDIA_PROVIDER, useValue: new StubAdverseMediaProvider() },
    { provide: WATCHLIST_SOURCES, useFactory: () => watchlistSourcesFromEnv() },
    { provide: WATCHLIST_FETCHER, useValue: httpFetcher },
  ],
  exports: [ScreeningService],
})
export class PlaftModule {}
