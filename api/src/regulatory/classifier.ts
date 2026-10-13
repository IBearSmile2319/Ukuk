import { EntityType } from '../tenancy/tenant';
import { addBusinessDays, addDays, containsPhrase, normalize, parseSpanishDate } from './text';

/**
 * Clasificación determinista de normas. Corre siempre; Claude (si está activo) solo
 * refina el resultado. Todo es puro para poder probarlo sin base de datos.
 */

export type NormScope = 'general' | 'particular';
export type NormStatus = 'vigente' | 'proyecto';

export const REG_TOPICS = [
  'plaft',
  'seguros',
  'siniestros',
  'datos_personales',
  'seguridad_informacion',
  'riesgo_operacional',
  'conducta_mercado',
  'gobierno_corporativo',
  'credito',
  'tributario',
  'pensiones',
] as const;
export type RegTopic = (typeof REG_TOPICS)[number];

export interface Article {
  number: string;
  text: string;
}

export interface Obligation {
  article: string;
  obligation: string;
  deadline: string | null;
}

export interface Classification {
  scope: NormScope;
  scopeReason: string;
  status: NormStatus;
  commentsDeadline: string | null;
  topics: RegTopic[];
  entityTypes: EntityType[];
  articles: Article[];
  effectiveAt: string | null;
  effectivePhrase: string | null;
  obligations: Obligation[];
  summary: string;
}

// Verbos con que empiezan los títulos de resoluciones particulares (dirigidas a una empresa o persona).
const PARTICULAR_START = [
  'autorizan',
  'autoriza',
  'inscripcion',
  'inscriben',
  'registro de',
  'registran',
  'designan',
  'designa',
  'aceptan renuncia',
  'aceptan la renuncia',
  'modifican la autorizacion',
  'otorgan',
  'cancelan',
  'revocan',
  'dejan sin efecto la autorizacion',
  'deniegan',
  'sancionan',
  'declaran fundado',
  'declaran infundado',
  'aprueban la fusion',
  'aprueban la conversion',
  'encargan',
];

const GENERAL_START = [
  'aprueban reglamento',
  'aprueban el reglamento',
  'aprueban normas',
  'aprueban las normas',
  'aprueban disposiciones',
  'aprueban el texto unico',
  'modifican el reglamento',
  'modifican reglamento',
  'modifican las normas',
  'modifican diversas',
  'modifican el manual',
  'disponen',
  'establecen',
  'normas para',
  'precisan',
  'sustituyen',
  'incorporan',
  'derogan',
  'proyecto de resolucion',
  'proyecto de reglamento',
  'prepublican',
  'ley ',
  'decreto supremo que',
];

// Sufijos societarios y tipos de entidad que delatan una resolución particular.
const COMPANY_MARKERS = /\b(s ?a ?a|s ?a ?c|s ?a|e ?i ?r ?l|s ?r ?l|caja municipal|cooperativa de ahorro y credito [a-z]+)\b/;

export function classifyScope(title: string): { scope: NormScope; reason: string } {
  const t = normalize(title);
  const startsWith = (list: string[]) => list.find((p) => t.startsWith(normalize(p)));
  const particular = startsWith(PARTICULAR_START);
  if (particular) return { scope: 'particular', reason: `título empieza con "${particular}"` };
  const general = startsWith(GENERAL_START);
  if (general) return { scope: 'general', reason: `título empieza con "${general.trim()}"` };
  if (COMPANY_MARKERS.test(t)) return { scope: 'particular', reason: 'menciona una empresa específica' };
  return { scope: 'general', reason: 'sin patrón particular; se asume general' };
}

const TOPIC_KEYWORDS: Record<RegTopic, string[]> = {
  plaft: [
    'lavado de activos', 'financiamiento del terrorismo', 'plaft', 'lafT', 'unidad de inteligencia financiera',
    'operaciones sospechosas', 'operacion sospechosa', 'oficial de cumplimiento', 'debida diligencia',
    'beneficiario final', 'sujetos obligados', 'listas restrictivas', 'proliferacion de armas',
  ],
  seguros: [
    'empresas de seguros', 'empresa de seguros', 'seguro', 'seguros', 'aseguradora', 'aseguradoras', 'poliza', 'polizas',
    'reaseguro', 'prima', 'primas', 'corredores de seguros', 'bancaseguros', 'microseguros', 'contratante', 'asegurado',
  ],
  siniestros: [
    'siniestro', 'siniestros', 'indemnizacion', 'ajustador', 'ajustadores', 'aviso de siniestro', 'cobertura',
    'consentido', 'liquidacion del siniestro',
  ],
  datos_personales: [
    'datos personales', 'ley 29733', 'titular de los datos', 'tratamiento de datos', 'banco de datos personales',
    'proteccion de datos',
  ],
  seguridad_informacion: [
    'seguridad de la informacion', 'ciberseguridad', 'incidente de seguridad', 'incidentes de ciberseguridad',
    'computacion en la nube', 'servicios en la nube', 'autenticacion', 'seguridad informatica',
  ],
  riesgo_operacional: [
    'riesgo operacional', 'continuidad del negocio', 'subcontratacion', 'subcontratacion significativa',
    'proveedores', 'gestion de la continuidad', 'riesgo de modelo',
  ],
  conducta_mercado: [
    'conducta de mercado', 'usuarios', 'usuario', 'transparencia de informacion', 'reclamos', 'reclamo',
    'publicidad', 'atencion al usuario', 'clausulas abusivas', 'hoja resumen', 'proteccion al consumidor',
  ],
  gobierno_corporativo: [
    'gobierno corporativo', 'directorio', 'gestion integral de riesgos', 'auditoria interna', 'comite de riesgos',
    'apetito por el riesgo',
  ],
  credito: [
    'credito', 'creditos', 'deudor', 'deudores', 'provisiones', 'cartera', 'sobreendeudamiento',
    'tarjeta de credito', 'tarjetas de credito', 'riesgo crediticio',
  ],
  tributario: ['sunat', 'impuesto', 'tributario', 'tributaria', 'igv', 'impuesto a la renta', 'comprobantes de pago'],
  pensiones: ['sistema privado de pensiones', 'afp', 'fondo de pensiones', 'pensiones', 'afiliados'],
};

/** Temas por diccionario; un tema entra con 2 apariciones o 1 en el título. */
export function detectTopics(title: string, text: string): RegTopic[] {
  const nt = normalize(title);
  const nb = normalize(text);
  const topics: RegTopic[] = [];
  for (const topic of REG_TOPICS) {
    let hits = 0;
    let inTitle = false;
    for (const kw of TOPIC_KEYWORDS[topic]) {
      const k = normalize(kw);
      if (containsPhrase(nt, k)) inTitle = true;
      hits += countPhrase(nb, k);
    }
    if (inTitle || hits >= 2) topics.push(topic);
  }
  return topics;
}

function countPhrase(normalizedText: string, normalizedPhrase: string): number {
  if (!normalizedPhrase) return 0;
  const hay = ` ${normalizedText} `;
  const needle = ` ${normalizedPhrase} `;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length - 1)) n++;
  return n;
}

const PLAFT_OBLIGATED: EntityType[] = [
  'aseguradora', 'banco', 'caja', 'cooperativa', 'financiera', 'fintech', 'casa_cambio', 'remesadora',
  'inmobiliaria', 'notaria', 'casino',
];

const ENTITY_KEYWORDS: [string, EntityType[]][] = [
  ['empresas de seguros', ['aseguradora']],
  ['empresa de seguros', ['aseguradora']],
  ['sistema de seguros', ['aseguradora', 'corredor']],
  ['aseguradoras', ['aseguradora']],
  ['corredores de seguros', ['corredor']],
  ['intermediarios de seguros', ['corredor']],
  ['afocat', ['afocat']],
  ['empresas del sistema financiero', ['banco', 'caja', 'financiera']],
  ['empresas bancarias', ['banco']],
  ['bancos', ['banco']],
  ['cajas municipales', ['caja']],
  ['cajas rurales', ['caja']],
  ['empresas financieras', ['financiera']],
  ['cooperativas de ahorro y credito', ['cooperativa']],
  ['empresas de transferencia de fondos', ['remesadora']],
  ['casas de cambio', ['casa_cambio']],
  ['financiamiento participativo', ['fintech']],
  ['empresas de prestamos', ['fintech']],
  ['notarios', ['notaria']],
  ['agentes inmobiliarios', ['inmobiliaria']],
  ['inmobiliarias', ['inmobiliaria']],
  ['casinos', ['casino']],
  ['juegos de casino', ['casino']],
  ['sujetos obligados', PLAFT_OBLIGATED],
];

/** Tipos de entidad a los que se dirige la norma. Vacío = aplica a todos. */
export function detectEntityTypes(title: string, text: string): EntityType[] {
  const n = normalize(`${title} ${text}`);
  const found = new Set<EntityType>();
  for (const [kw, types] of ENTITY_KEYWORDS) if (containsPhrase(n, kw)) types.forEach((t) => found.add(t));
  return [...found];
}

const ORDINALS: Record<string, number> = {
  primera: 1, segunda: 2, tercera: 3, cuarta: 4, quinta: 5, sexta: 6, setima: 7, septima: 7, octava: 8,
  novena: 9, decima: 10, unica: 1,
};

/**
 * Divide el texto en artículos ("Artículo 1.-", "Artículo 2°.-", "Art. 3.-") y
 * disposiciones complementarias ("Primera.-" bajo "Disposiciones Complementarias Finales").
 * Lo anterior al primer artículo (considerandos) se descarta.
 */
export function splitArticles(text: string): Article[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const articles: Article[] = [];
  let current: Article | null = null;
  let section = '';
  const articleRe = /^\s*(?:Art[íi]culo|ART[ÍI]CULO|Art\.)\s*(\d+[A-Za-z]?)\s*[°º]?\s*\.?\s*[-–—:]+\s*(.*)$/;
  const sectionRe = /^\s*DISPOSICI[OÓ]N(?:ES)?\s+COMPLEMENTARIA(?:S)?\s+(FINAL(?:ES)?|TRANSITORIA(?:S)?|MODIFICATORIA(?:S)?|DEROGATORIA(?:S)?)\s*$/i;
  const ordinalRe = /^\s*(Primera|Segunda|Tercera|Cuarta|Quinta|Sexta|S[eé]ptima|Setima|Octava|Novena|D[eé]cima|[ÚU]nica)\s*\.?\s*[-–—:]+\s*(.*)$/i;
  const push = () => {
    if (current) articles.push({ number: current.number, text: current.text.trim() });
  };
  for (const line of lines) {
    const sec = sectionRe.exec(line);
    if (sec) {
      push();
      current = null;
      const kind = normalize(sec[1]).replace(/es$|s$/, '');
      section = { final: 'DCF', transitoria: 'DCT', modificatoria: 'DCM', derogatoria: 'DCD' }[kind] ?? 'DC';
      continue;
    }
    const art = articleRe.exec(line);
    if (art) {
      push();
      current = { number: art[1], text: art[2] };
      continue;
    }
    const ord = section ? ordinalRe.exec(line) : null;
    if (ord) {
      push();
      current = { number: `${section}-${ORDINALS[normalize(ord[1])] ?? ord[1]}`, text: ord[2] };
      continue;
    }
    if (current) current.text += `\n${line}`;
  }
  push();
  return articles;
}

/**
 * Fecha de entrada en vigencia a partir de frases típicas. Se buscan primero las
 * oraciones que hablan de "vigencia"/"vigor". Devuelve null si no hay frase reconocible.
 */
export function extractEffectiveDate(text: string, publishedAt: string): { date: string; phrase: string } | null {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.;])\s+/)
    .filter((s) => /vigencia|vigor|rige|regira/i.test(normalize(s)));
  for (const s of sentences) {
    const n = normalize(s);
    const phrase = s.trim().slice(0, 300);
    if (/dia siguiente (?:de|a) (?:su|la) publicacion/.test(n)) return { date: addDays(publishedAt, 1), phrase };
    const explicit = parseSpanishDate(n);
    if (explicit && /(?:a partir|desde|el|vigencia)/.test(n)) return { date: explicit, phrase };
    const plazo = /(?:plazo de|a los|luego de|despues de)\s+(\d{1,4})\s+dias(?:\s+(calendario|habiles))?/.exec(n);
    if (plazo) {
      const days = Number(plazo[1]);
      const date = plazo[2] === 'habiles' ? addBusinessDays(publishedAt, days) : addDays(publishedAt, days);
      return { date, phrase };
    }
    if (/(?:a partir de|desde) (?:la fecha de )?su publicacion/.test(n)) return { date: publishedAt, phrase };
  }
  return null;
}

/** Proyectos prepublicados para comentarios y su fecha límite. */
export function detectProject(title: string, text: string, publishedAt: string): { status: NormStatus; commentsDeadline: string | null } {
  const nt = normalize(title);
  const nb = normalize(text);
  const isProject =
    /\b(proyecto de|prepublica|prepublicacion|prepublican)\b/.test(nt) ||
    /\b(prepublicar|prepublicacion)\b.*\bcomentarios\b/.test(nb) ||
    /\bcomentarios\b.*\bproyecto\b/.test(nt);
  if (!isProject) return { status: 'vigente', commentsDeadline: null };
  let deadline: string | null = null;
  const idx = nb.indexOf('comentario');
  if (idx >= 0) {
    const around = nb.slice(idx, idx + 400);
    deadline = parseSpanishDate(around);
    if (!deadline) {
      const plazo = /plazo de\s+(\d{1,3})\s+dias(?:\s+(calendario|habiles))?/.exec(around) ??
        /plazo de\s+(\d{1,3})\s+dias(?:\s+(calendario|habiles))?/.exec(nb);
      if (plazo) {
        deadline = plazo[2] === 'habiles' ? addBusinessDays(publishedAt, Number(plazo[1])) : addDays(publishedAt, Number(plazo[1]));
      }
    }
  }
  return { status: 'proyecto', commentsDeadline: deadline };
}

/** Obligaciones heurísticas: oraciones con "deben/deberán/están obligadas" por artículo. */
export function extractObligations(articles: Article[]): Obligation[] {
  const out: Obligation[] = [];
  for (const a of articles) {
    for (const s of a.text.replace(/\s+/g, ' ').split(/(?<=[.;])\s+/)) {
      if (/\b(deben|deber[aá]n|est[aá]n obligad[ao]s|tienen la obligaci[oó]n)\b/i.test(s)) {
        const plazo = /\b(?:plazo (?:m[aá]ximo )?de|dentro de(?: los)?)\s+(\d{1,3})\s+d[ií]as[^.;,]*/i.exec(s);
        out.push({ article: a.number, obligation: s.trim().slice(0, 400), deadline: plazo ? plazo[0] : null });
      }
    }
  }
  return out.slice(0, 30);
}

/** Resumen sin LLM: primeras oraciones del artículo 1 (objeto), hasta ~80 palabras. */
export function fallbackSummary(title: string, articles: Article[]): string {
  const base = articles[0]?.text || title;
  const words = base.replace(/\s+/g, ' ').trim().split(' ');
  return words.length > 80 ? `${words.slice(0, 80).join(' ')}…` : words.join(' ');
}

export function classifyNorm(input: { title: string; text?: string | null; publishedAt: string }): Classification {
  const text = input.text ?? '';
  const scope = classifyScope(input.title);
  const project = detectProject(input.title, text, input.publishedAt);
  const articles = text ? splitArticles(text) : [];
  const effective = text ? extractEffectiveDate(text, input.publishedAt) : null;
  return {
    scope: scope.scope,
    scopeReason: scope.reason,
    status: project.status,
    commentsDeadline: project.commentsDeadline,
    topics: detectTopics(input.title, text),
    entityTypes: detectEntityTypes(input.title, text),
    articles,
    effectiveAt: effective?.date ?? null,
    effectivePhrase: effective?.phrase ?? null,
    obligations: extractObligations(articles),
    summary: fallbackSummary(input.title, articles),
  };
}
