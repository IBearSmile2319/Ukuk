import { PoliteFetcher, RawNorm, SourceAdapter, decodeEntities, dmyToIso, htmlToText } from './source-adapter';

// Emisores que interesan a entidades supervisadas; el resto del diario se ignora.
const ISSUERS = /SUPERINTENDENCIA DE BANCA|MERCADO DE VALORES|BANCO CENTRAL DE RESERVA|SUPERINTENDENCIA NACIONAL DE SALUD|INDECOPI|CONGRESO|ECONOM[IÍ]A Y FINANZAS|JUSTICIA Y DERECHOS HUMANOS|UNIDAD DE INTELIGENCIA FINANCIERA/i;

/**
 * El Peruano — Normas Legales. Sin API ni RSS oficial: se lee el listado HTML del día
 * y luego cada dispositivo. DESACTIVADO por defecto hasta tener autorización de
 * Editora Perú. TODO: confirmar el marcado real del sitio y la URL del listado.
 */
export class ElPeruanoAdapter implements SourceAdapter {
  readonly source = 'el_peruano' as const;

  constructor(
    private readonly http: PoliteFetcher,
    private readonly baseUrl = 'https://busquedas.elperuano.pe',
  ) {}

  async fetchSince(date: string): Promise<RawNorm[]> {
    const out: RawNorm[] = [];
    for (const day of daysUntilToday(date)) {
      const html = await this.http.text(`${this.baseUrl}/normaslegales/?fecha=${day}`);
      for (const item of parseElPeruanoListing(html, this.baseUrl)) {
        if (!ISSUERS.test(item.issuer ?? '')) continue;
        if (item.url) item.text = parseElPeruanoDetail(await this.http.text(item.url));
        out.push(item);
      }
    }
    return out;
  }
}

/** Listado del día: un <article> por dispositivo con emisor (h4), título (h5 > a), fecha y número. */
export function parseElPeruanoListing(html: string, baseUrl = 'https://busquedas.elperuano.pe'): RawNorm[] {
  const out: RawNorm[] = [];
  for (const block of html.split(/<article\b/i).slice(1)) {
    const link = /<h5[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = new URL(decodeEntities(link[1]), baseUrl).toString();
    const externalId = /\/dispositivo\/[A-Z]+\/([\w-]+)/i.exec(url)?.[1] ?? url;
    const issuer = /<h4[^>]*>([\s\S]*?)<\/h4>/i.exec(block)?.[1];
    const paragraphs = [...block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => htmlToText(m[1]));
    const publishedAt = paragraphs.map((p) => dmyToIso(p)).find(Boolean);
    const number = paragraphs.find((p) => /^(RESOLUCI[OÓ]N|DECRETO|LEY|CIRCULAR)/i.test(p));
    const pdf = /href="([^"]+\.pdf)"/i.exec(block)?.[1];
    if (!publishedAt) continue;
    out.push({
      source: 'el_peruano',
      externalId,
      issuer: issuer ? htmlToText(issuer) : undefined,
      number,
      title: htmlToText(link[2]),
      publishedAt,
      url,
      pdfUrl: pdf ? new URL(decodeEntities(pdf), baseUrl).toString() : undefined,
    });
  }
  return out;
}

/** Texto del dispositivo: el contenedor #contenido (o el body si no existe). */
export function parseElPeruanoDetail(html: string): string {
  const m = /<div[^>]*id="contenido"[^>]*>([\s\S]*?)<\/div>\s*<!--\s*fin contenido\s*-->/i.exec(html) ??
    /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return htmlToText(m ? m[1] : html);
}

export function daysUntilToday(from: string, today = new Date()): string[] {
  const days: string[] = [];
  const end = today.toISOString().slice(0, 10);
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= end && days.length < 31; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}
