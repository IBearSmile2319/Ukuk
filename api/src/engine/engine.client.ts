import { HttpException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import {
  AnalyzeRequest,
  AnalyzeResponse,
  BatchScreenRequest,
  BatchScreenResponse,
  ScreenRequest,
  ScreenResponse,
  WatchlistCategory,
  WatchlistFormat,
  WatchlistInfo,
} from './engine.types';

/** Cliente HTTP del motor Rust. Los módulos dependen de esta clase; los tests la reemplazan. */
@Injectable()
export class EngineClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private async call<T>(method: string, path: string, body?: unknown, raw?: Buffer): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.config.engineUrl}${path}`, {
        method,
        headers: raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new ServiceUnavailableException(`Motor no disponible: ${(err as Error).message}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      throw new HttpException(
        { error: json?.error ?? 'engine_error', message: json?.message ?? `Motor respondió ${res.status}` },
        res.status >= 500 ? 502 : res.status,
      );
    }
    return json as T;
  }

  health(): Promise<{ status: string; version: string }> {
    return this.call('GET', '/health');
  }

  analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
    return this.call('POST', '/v1/analyze', req);
  }

  validateRuc(ruc: string): Promise<{ valid: boolean; kind: string }> {
    return this.call('POST', '/v1/rules/ruc', { ruc });
  }

  loadWatchlist(
    source: string,
    format: WatchlistFormat,
    category: WatchlistCategory,
    data: Buffer,
  ): Promise<WatchlistInfo> {
    const q = new URLSearchParams({ format, category });
    return this.call('PUT', `/v1/watchlists/${encodeURIComponent(source)}?${q}`, undefined, data);
  }

  listWatchlists(): Promise<WatchlistInfo[]> {
    return this.call('GET', '/v1/watchlists');
  }

  screen(req: ScreenRequest): Promise<ScreenResponse> {
    return this.call('POST', '/v1/screen', req);
  }

  screenBatch(req: BatchScreenRequest): Promise<BatchScreenResponse> {
    return this.call('POST', '/v1/screen/batch', req);
  }
}
