import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ElPeruanoAdapter, daysUntilToday, parseElPeruanoDetail, parseElPeruanoListing } from './el-peruano.adapter';
import { parseSbsTable } from './sbs.adapter';
import { PoliteFetcher, enabledSources } from './source-adapter';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('adaptadores de fuentes', () => {
  it('desactivados por defecto', () => {
    expect(enabledSources({})).toEqual([]);
    expect(enabledSources({ UKUK_REG_SOURCES: 'el_peruano, sbs,otra' })).toEqual(['el_peruano', 'sbs']);
  });

  it('lee el listado de El Peruano', () => {
    const items = parseElPeruanoListing(fixture('el-peruano.html'));
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      externalId: '2450001-1',
      issuer: 'SUPERINTENDENCIA DE BANCA, SEGUROS Y AFP',
      number: 'RESOLUCIÓN SBS N° 03050-2026',
      title: 'Aprueban Reglamento de Gestión de Siniestros',
      publishedAt: '2026-10-13',
      url: 'https://busquedas.elperuano.pe/dispositivo/NL/2450001-1',
      pdfUrl: 'https://busquedas.elperuano.pe/download/url/2450001-1.pdf',
    });
    expect(parseElPeruanoDetail(fixture('el-peruano-detail.html'))).toMatch(/Artículo 1\.- Objeto\nAprobar el Reglamento/);
  });

  it('fetchSince filtra emisores y trae el detalle con fetch falso, sin red', async () => {
    const urls: string[] = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      urls.push(url);
      expect((init?.headers as Record<string, string>)['user-agent']).toMatch(/Ukuk/);
      return new Response(url.includes('/dispositivo/') ? fixture('el-peruano-detail.html') : fixture('el-peruano.html'));
    };
    const adapter = new ElPeruanoAdapter(new PoliteFetcher(fakeFetch, 0));
    const today = new Date().toISOString().slice(0, 10);
    const norms = await adapter.fetchSince(today);
    expect(norms.map((n) => n.externalId)).toEqual(['2450001-1', '2450002-1']);
    expect(norms[0].text).toMatch(/entra en vigencia/);
    expect(urls.filter((u) => u.includes('2450003'))).toEqual([]);
  });

  it('lee proyectos de la SBS con plazo de comentarios', () => {
    const items = parseSbsTable(fixture('sbs-proyectos.html'), 'https://www.sbs.gob.pe/normativa/', 'proyecto');
    expect(items).toEqual([
      expect.objectContaining({
        source: 'sbs',
        externalId: 'PROYECTO RES. SBS N° 2026-0045',
        status: 'proyecto',
        commentsDeadline: '2026-10-30',
        pdfUrl: 'https://www.sbs.gob.pe/docs/proyecto-45.pdf',
      }),
    ]);
  });

  it('el fetcher respeta la pausa mínima por host', async () => {
    const times: number[] = [];
    const http = new PoliteFetcher(async () => {
      times.push(Date.now());
      return new Response('ok');
    }, 50);
    await Promise.all([http.text('https://a.pe/1'), http.text('https://a.pe/2')]);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(45);
  });

  it('rango de días acotado', () => {
    expect(daysUntilToday('2026-10-11', new Date('2026-10-13T12:00:00Z'))).toEqual(['2026-10-11', '2026-10-12', '2026-10-13']);
  });
});
