import { PoliteFetcher, RawNorm, SourceAdapter, decodeEntities, dmyToIso, htmlToText } from './source-adapter';

/**
 * SBS — resoluciones y proyectos prepublicados para comentarios. La SBS publica en
 * una aplicación web con PDFs; se leen las tablas HTML de ambos listados.
 * DESACTIVADO por defecto. TODO: confirmar URLs/marcado reales y extraer el texto
 * del PDF (pdftotext o Textract); por ahora el texto queda vacío y se clasifica por título.
 */
export class SbsAdapter implements SourceAdapter {
  readonly source = 'sbs' as const;

  constructor(
    private readonly http: PoliteFetcher,
    private readonly resolutionsUrl = 'https://www.sbs.gob.pe/normativa/resoluciones',
    private readonly projectsUrl = 'https://www.sbs.gob.pe/normativa/proyectos-normativos',
  ) {}

  async fetchSince(date: string): Promise<RawNorm[]> {
    const resolutions = parseSbsTable(await this.http.text(this.resolutionsUrl), this.resolutionsUrl, 'vigente');
    const projects = parseSbsTable(await this.http.text(this.projectsUrl), this.projectsUrl, 'proyecto');
    return [...resolutions, ...projects].filter((n) => n.publishedAt >= date);
  }
}

/**
 * Filas: número | fecha | título (enlace al PDF) | [plazo para comentarios].
 */
export function parseSbsTable(html: string, baseUrl: string, status: 'vigente' | 'proyecto'): RawNorm[] {
  const out: RawNorm[] = [];
  for (const row of html.split(/<tr\b/i).slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 3) continue;
    const number = htmlToText(cells[0]);
    const publishedAt = dmyToIso(htmlToText(cells[1]));
    const link = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(cells[2]);
    if (!publishedAt || !number) continue;
    const pdfUrl = link ? new URL(decodeEntities(link[1]), baseUrl).toString() : undefined;
    out.push({
      source: 'sbs',
      externalId: number.replace(/\s+/g, ' ').toUpperCase(),
      issuer: 'Superintendencia de Banca, Seguros y AFP',
      number,
      title: htmlToText(link ? link[2] : cells[2]),
      publishedAt,
      url: pdfUrl,
      pdfUrl,
      status,
      commentsDeadline: status === 'proyecto' && cells[3] ? (dmyToIso(htmlToText(cells[3])) ?? undefined) : undefined,
    });
  }
  return out;
}
