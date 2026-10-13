import {
  classifyNorm,
  classifyScope,
  detectEntityTypes,
  detectProject,
  detectTopics,
  extractEffectiveDate,
  extractObligations,
  splitArticles,
} from './classifier';
import { SAMPLE_NORM_TEXT } from './sources/fixtures/sample-norm';

describe('classifyScope', () => {
  it.each([
    ['Autorizan a Rímac Seguros y Reaseguros la apertura de oficinas', 'particular'],
    ['Autoriza a la Caja Municipal de Ahorro y Crédito de Piura el traslado de agencia', 'particular'],
    ['Inscripción de la señora María Pérez en el Registro de Intermediarios', 'particular'],
    ['Registro de Peritos Valuadores: inscriben a Juan López', 'particular'],
    ['Designan Superintendente Adjunto de Riesgos', 'particular'],
    ['Aceptan renuncia de funcionario', 'particular'],
    ['Modifican la autorización de funcionamiento otorgada a Financiera X', 'particular'],
    ['Aprueban Reglamento de Gestión de Siniestros', 'general'],
    ['Modifican el Reglamento de Transparencia de Información', 'general'],
    ['Disponen la prepublicación del proyecto de resolución', 'general'],
    ['Establecen disposiciones sobre ciberseguridad', 'general'],
    ['Normas para la prevención del lavado de activos', 'general'],
    ['La Positiva Seguros S.A.A. presenta estados financieros', 'particular'],
  ])('%s → %s', (title, scope) => {
    expect(classifyScope(title).scope).toBe(scope);
  });
});

describe('detectTopics y entidades', () => {
  it('detecta seguros y siniestros', () => {
    const topics = detectTopics('Aprueban Reglamento de Gestión de Siniestros', SAMPLE_NORM_TEXT);
    expect(topics).toEqual(expect.arrayContaining(['seguros', 'siniestros']));
    expect(topics).not.toContain('credito');
  });

  it('detecta PLAFT y sujetos obligados', () => {
    const text = 'Los sujetos obligados deben reportar operaciones sospechosas a la UIF sobre lavado de activos.';
    expect(detectTopics('Modifican norma', text)).toContain('plaft');
    expect(detectEntityTypes('Modifican norma', text)).toEqual(expect.arrayContaining(['aseguradora', 'casa_cambio']));
  });

  it('entidades vacías = aplica a todos', () => {
    expect(detectEntityTypes('Disponen medidas', 'texto sin destinatario')).toEqual([]);
    expect(detectEntityTypes('', SAMPLE_NORM_TEXT)).toEqual(['aseguradora']);
  });
});

describe('splitArticles', () => {
  it('separa artículos y disposiciones complementarias', () => {
    const arts = splitArticles(SAMPLE_NORM_TEXT);
    expect(arts.map((a) => a.number)).toEqual(['1', '2', '3', 'DCF-1', 'DCF-2']);
    expect(arts[1].text).toMatch(/^Aviso de siniestro por medios digitales\nLas empresas de seguros deben/);
    expect(arts[0].text).not.toMatch(/CONSIDERANDO/);
  });

  it('acepta Art. y guiones largos', () => {
    expect(splitArticles('Art. 5 – Uno\nArtículo 6º.- Dos').map((a) => a.number)).toEqual(['5', '6']);
  });
});

describe('extractEffectiveDate', () => {
  it('día siguiente de su publicación', () => {
    const r = extractEffectiveDate('La presente norma entra en vigencia a partir del día siguiente de su publicación en el diario oficial.', '2026-10-13');
    expect(r?.date).toBe('2026-10-14');
  });

  it('fecha explícita', () => {
    expect(extractEffectiveDate(SAMPLE_NORM_TEXT, '2026-10-13')?.date).toBe('2027-01-01');
    expect(extractEffectiveDate('Rige desde el 1° de marzo del 2027.', '2026-10-13')?.date).toBe('2027-03-01');
  });

  it('plazo en días calendario y hábiles', () => {
    expect(extractEffectiveDate('La resolución entra en vigencia en un plazo de 90 días calendario.', '2026-10-13')?.date).toBe('2027-01-11');
    // 2026-10-13 es martes: 5 días hábiles → martes 20.
    expect(extractEffectiveDate('Entra en vigencia luego de 5 días hábiles.', '2026-10-13')?.date).toBe('2026-10-20');
  });

  it('sin frase de vigencia', () => {
    expect(extractEffectiveDate('Texto sin fecha.', '2026-10-13')).toBeNull();
  });
});

describe('proyectos y obligaciones', () => {
  it('detecta proyecto y plazo de comentarios', () => {
    const p = detectProject(
      'Proyecto de Resolución que modifica el Reglamento de Siniestros',
      'Los interesados podrán remitir sus comentarios hasta el 30 de octubre de 2026 al correo prepublicacion@sbs.gob.pe',
      '2026-10-13',
    );
    expect(p).toEqual({ status: 'proyecto', commentsDeadline: '2026-10-30' });
    const q = detectProject('Prepublican proyecto', 'Los comentarios se recibirán en un plazo de 15 días calendario.', '2026-10-13');
    expect(q.commentsDeadline).toBe('2026-10-28');
  });

  it('extrae obligaciones con plazo', () => {
    const obs = extractObligations(splitArticles(SAMPLE_NORM_TEXT));
    expect(obs.map((o) => o.article)).toEqual(['2', '3']);
    expect(obs[1].deadline).toMatch(/30 días/);
  });

  it('classifyNorm junta todo', () => {
    const c = classifyNorm({ title: 'Aprueban Reglamento de Gestión de Siniestros', text: SAMPLE_NORM_TEXT, publishedAt: '2026-10-13' });
    expect(c).toMatchObject({ scope: 'general', status: 'vigente', effectiveAt: '2027-01-01', entityTypes: ['aseguradora'] });
    expect(c.summary.split(' ').length).toBeLessThanOrEqual(81);
  });
});
