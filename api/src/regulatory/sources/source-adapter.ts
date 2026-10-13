export const NORM_SOURCES = ['el_peruano', 'sbs', 'smv', 'bcrp', 'uif', 'susalud', 'indecopi'] as const;
export type NormSource = (typeof NORM_SOURCES)[number];

/** Norma tal como la entrega una fuente, antes de clasificar. */
export interface RawNorm {
  source: NormSource;
  externalId: string;
  issuer?: string;
  number?: string;
  title: string;
  publishedAt: string; // YYYY-MM-DD
  url?: string;
  pdfUrl?: string;
  text?: string;
  status?: 'vigente' | 'proyecto';
  commentsDeadline?: string;
}

export interface SourceAdapter {
  readonly source: NormSource;
  fetchSince(date: string): Promise<RawNorm[]>;
}

export const SOURCE_ADAPTERS = Symbol('SOURCE_ADAPTERS');

/**
 * Fuentes habilitadas (env UKUK_REG_SOURCES=el_peruano,sbs). Desactivadas por
 * defecto: antes de automatizar El Peruano hay que tener autorización de Editora Perú.
 */
export function enabledSources(env: NodeJS.ProcessEnv = process.env): NormSource[] {
  return (env.UKUK_REG_SOURCES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is NormSource => (NORM_SOURCES as readonly string[]).includes(s));
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Cliente HTTP cortés: User-Agent identificable, una petición a la vez por host con
 * pausa mínima entre ellas y tiempo de espera. TODO: respetar robots.txt.
 */
export class PoliteFetcher {
  private readonly lastByHost = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly minIntervalMs = 3000,
    readonly userAgent = 'UkukRadarRegulatorio/0.1 (+https://ukuk.pe/bot; cumplimiento@ukuk.pe)',
  ) {}

  text(url: string): Promise<string> {
    const run = async () => {
      const host = new URL(url).host;
      const wait = (this.lastByHost.get(host) ?? 0) + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastByHost.set(host, Date.now());
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': this.userAgent, accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
      return res.text();
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

/** HTML → texto plano conservando saltos de párrafo. Sin dependencias. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h\d|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í',
    oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
    Ntilde: 'Ñ', deg: '°', ordm: 'º', uuml: 'ü',
  };
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n] ?? m);
}

/** dd/mm/yyyy → yyyy-mm-dd */
export function dmyToIso(s: string): string | null {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
