import { splitArticles } from './classifier';
import { SAMPLE_NORM_TEXT } from './sources/fixtures/sample-norm';
import { MatchNorm, MatchProcess, isNormRelevant, matchProcesses } from './matching';

const norm: MatchNorm = {
  scope: 'general',
  topics: ['seguros', 'siniestros'],
  entityTypes: ['aseguradora'],
  title: 'Aprueban Reglamento de Gestión de Siniestros',
  articles: splitArticles(SAMPLE_NORM_TEXT),
};

const processes: MatchProcess[] = [
  {
    id: 'p1',
    code: 'SIN-01',
    name: 'Proceso de atención de siniestros',
    description: 'Recepción del aviso de siniestro, canales de atención al asegurado, documentos y plazo de pronunciamiento.',
    topics: ['siniestros'],
    keywords: ['aviso de siniestro', 'whatsapp'],
  },
  {
    id: 'p2',
    code: 'TES-01',
    name: 'Manual de tesorería',
    description: 'Inversiones, caja y conciliaciones bancarias.',
    topics: ['tesoreria'],
    keywords: ['inversiones'],
  },
  {
    id: 'p3',
    code: 'PLA-01',
    name: 'Política PLAFT',
    description: 'Debida diligencia del cliente y reporte de operaciones sospechosas.',
    topics: ['plaft'],
    keywords: [],
  },
];

describe('matchProcesses', () => {
  const profile = { entityType: 'aseguradora' as const, topics: ['seguros', 'siniestros', 'plaft'] };

  it('vincula el proceso de siniestros con los artículos pertinentes', () => {
    const m = matchProcesses(norm, profile, processes);
    expect(m.map((x) => x.processCode)).toEqual(['SIN-01']);
    expect(m[0].score).toBeGreaterThan(0.5);
    expect(m[0].articles[0].number).toBe('2');
    expect(m[0].articles[0].keywords).toEqual(['aviso de siniestro', 'whatsapp']);
    expect(m[0].rationale).toMatch(/temas en común: siniestros/);
  });

  it('el umbral es configurable', () => {
    expect(matchProcesses(norm, profile, processes, { threshold: 0.99 })).toEqual([]);
  });

  it('ignora normas particulares, de otro tipo de entidad o sin temas en común', () => {
    expect(matchProcesses({ ...norm, scope: 'particular' }, profile, processes)).toEqual([]);
    expect(isNormRelevant({ ...norm, entityTypes: ['banco'] }, profile)).toBe(false);
    expect(isNormRelevant({ ...norm, entityTypes: [] }, profile)).toBe(true);
    expect(isNormRelevant({ ...norm, topics: ['credito'] }, profile)).toBe(false);
  });

  it('insensible a tildes', () => {
    const accentless = { ...processes[0], description: 'recepcion del aviso de siniestro y documentacion del asegurado', keywords: ['WHATSAPP'] };
    expect(matchProcesses(norm, profile, [accentless])).toHaveLength(1);
  });
});
