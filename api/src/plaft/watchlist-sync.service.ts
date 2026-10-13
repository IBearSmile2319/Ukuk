import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { EngineClient } from '../engine/engine.client';
import { WatchlistCategory, WatchlistFormat, WatchlistInfo } from '../engine/engine.types';
import { TenantsService } from '../tenancy/tenants.service';
import { ScreeningService } from './screening.service';

export interface WatchlistSource {
  source: string;
  url: string;
  format: WatchlistFormat;
  category: WatchlistCategory;
}

/** Listas públicas que se descargan cada noche. La UE y la SBS se suman cuando haya formato estable. */
export const DEFAULT_WATCHLIST_SOURCES: WatchlistSource[] = [
  { source: 'ofac_sdn', url: 'https://www.treasury.gov/ofac/downloads/sdn.csv', format: 'ofac_sdn_csv', category: 'sanction' },
  { source: 'un', url: 'https://scsanctions.un.org/resources/xml/sp/consolidated.xml', format: 'un_xml', category: 'sanction' },
];

export const WATCHLIST_SOURCES = Symbol('WATCHLIST_SOURCES');
export const WATCHLIST_FETCHER = Symbol('WATCHLIST_FETCHER');
export type WatchlistFetcher = (url: string) => Promise<Buffer>;

/** UKUK_WATCHLIST_SOURCES (JSON con la misma forma) reemplaza la lista por defecto. */
export function watchlistSourcesFromEnv(env: NodeJS.ProcessEnv = process.env): WatchlistSource[] {
  if (!env.UKUK_WATCHLIST_SOURCES) return DEFAULT_WATCHLIST_SOURCES;
  const parsed = JSON.parse(env.UKUK_WATCHLIST_SOURCES);
  if (!Array.isArray(parsed)) throw new Error('UKUK_WATCHLIST_SOURCES debe ser un arreglo JSON');
  return parsed as WatchlistSource[];
}

export const httpFetcher: WatchlistFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url}`);
  return Buffer.from(await res.arrayBuffer());
};

export type LoadResult = WatchlistInfo & { format: WatchlistFormat; changed: boolean };

@Injectable()
export class WatchlistSyncService {
  private readonly logger = new Logger(WatchlistSyncService.name);
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WATCHLIST_SOURCES) private readonly sources: WatchlistSource[],
    @Inject(WATCHLIST_FETCHER) private readonly fetcher: WatchlistFetcher,
    private readonly db: DbService,
    private readonly engine: EngineClient,
    private readonly tenants: TenantsService,
    private readonly screening: ScreeningService,
  ) {}

  /** Carga una lista en el motor y registra su versión (hash) en watchlist_versions. */
  async load(source: string, format: WatchlistFormat, category: WatchlistCategory, data: Buffer): Promise<LoadResult> {
    const info = await this.engine.loadWatchlist(source, format, category, data);
    const last = await this.db.query<{ version: string }>(
      'SELECT version FROM watchlist_versions WHERE source = $1 ORDER BY id DESC LIMIT 1',
      [source],
    );
    const changed = last[0]?.version !== info.version;
    await this.db.query(
      'INSERT INTO watchlist_versions (source, category, format, version, entries, changed) VALUES ($1,$2,$3,$4,$5,$6)',
      [source, info.category ?? category, format, info.version, info.entries, changed],
    );
    this.logger.log(`Lista ${source}: ${info.entries} entradas${changed ? ' (nueva versión)' : ''}`);
    return { ...info, format, changed };
  }

  /** Descarga y carga todas las fuentes; si alguna cambió, revisa de nuevo las carteras. */
  async syncAll(opts: { rescreen: boolean }) {
    const results: (LoadResult | { source: string; error: string })[] = [];
    for (const s of this.sources) {
      try {
        results.push(await this.load(s.source, s.format, s.category, await this.fetcher(s.url)));
      } catch (err) {
        this.logger.error(`No se pudo sincronizar ${s.source}: ${(err as Error).message}`);
        results.push({ source: s.source, error: (err as Error).message });
      }
    }
    const changed = results.some((r) => 'changed' in r && r.changed);
    const rescreen = changed && opts.rescreen ? await this.rescreenAll() : null;
    return { results, changed, rescreen };
  }

  /** Revisa la cartera monitoreada de cada cliente con PLAFT activo. */
  async rescreenAll() {
    const out: { tenant_id: string; error?: string; subjects?: number; cases_opened?: number }[] = [];
    for (const tenant of await this.tenants.listActive('plaft')) {
      try {
        const s = await this.screening.rescreenTenant(tenant, 'system:watchlist_sync');
        out.push({ tenant_id: tenant.id, subjects: s.subjects, cases_opened: s.cases_opened });
      } catch (err) {
        this.logger.error(`Revisión de cartera falló para ${tenant.id}: ${(err as Error).message}`);
        out.push({ tenant_id: tenant.id, error: (err as Error).message });
      }
    }
    return out;
  }

  listVersions() {
    return this.db.query(
      `SELECT DISTINCT ON (source) source, category, format, version, entries, loaded_at
         FROM watchlist_versions ORDER BY source, id DESC`,
    );
  }

  @Cron('0 2 * * *', { name: 'plaft-watchlist-sync', timeZone: 'America/Lima' })
  async nightly() {
    if (!this.config.jobsEnabled || this.running) return;
    this.running = true;
    try {
      await this.syncAll({ rescreen: true });
    } finally {
      this.running = false;
    }
  }
}
