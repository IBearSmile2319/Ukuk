import { EntityType } from '../tenancy/tenant';
import { Article } from './classifier';
import { containsPhrase, cosine, normalize, tfidfVectors, tokenize } from './text';

/** Cruce norma × procesos del cliente. Puro: lo usan el servicio y las pruebas. */

export interface MatchNorm {
  scope: 'general' | 'particular';
  topics: string[];
  entityTypes: string[];
  title: string;
  articles: Article[];
  text?: string | null;
}

export interface MatchProcess {
  id: string;
  code: string;
  name: string;
  description: string;
  topics: string[];
  keywords: string[];
}

export interface TenantProfile {
  entityType: EntityType;
  /** Líneas de negocio del cliente + temas de su inventario de procesos. */
  topics: string[];
}

export interface MatchedArticle {
  number: string;
  score: number;
  keywords: string[];
  excerpt: string;
}

export interface ProcessMatch {
  processId: string;
  processCode: string;
  score: number;
  topicOverlap: number;
  articles: MatchedArticle[];
  rationale: string;
}

export interface MatchOptions {
  /** Relevancia mínima para registrar el impacto (0..1). */
  threshold?: number;
  /** Artículos que se conservan por proceso. */
  maxArticles?: number;
}

export const DEFAULT_THRESHOLD = 0.3;
const MIN_ARTICLE_SIM = 0.05;

/** ¿La norma le importa a este cliente? Solo generales, de su tipo de entidad y temas. */
export function isNormRelevant(norm: Pick<MatchNorm, 'scope' | 'topics' | 'entityTypes'>, profile: TenantProfile): boolean {
  if (norm.scope !== 'general') return false;
  if (norm.entityTypes.length && !norm.entityTypes.includes(profile.entityType)) return false;
  const mine = new Set(profile.topics);
  return norm.topics.some((t) => mine.has(t));
}

/**
 * Puntaje por proceso = 0.25·solapamiento de temas + 0.55·mejor coseno TF-IDF entre
 * un artículo y la descripción del proceso + 0.2·palabras clave encontradas.
 * Con solo temas en común no se llega al umbral por defecto: hace falta texto.
 */
export function matchProcesses(
  norm: MatchNorm,
  profile: TenantProfile,
  processes: MatchProcess[],
  opts: MatchOptions = {},
): ProcessMatch[] {
  if (!isNormRelevant(norm, profile) || !processes.length) return [];
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxArticles = opts.maxArticles ?? 3;
  const articles = norm.articles.length
    ? norm.articles
    : [{ number: '-', text: `${norm.title}\n${norm.text ?? ''}` }];

  const articleTokens = articles.map((a) => tokenize(a.text));
  const processTokens = processes.map((p) => [
    ...tokenize(`${p.name} ${p.description}`),
    // Las palabras clave pesan doble.
    ...tokenize(p.keywords.join(' ')),
    ...tokenize(p.keywords.join(' ')),
  ]);
  const vectors = tfidfVectors([...articleTokens, ...processTokens]);
  const articleVecs = vectors.slice(0, articles.length);
  const normalizedArticles = articles.map((a) => normalize(a.text));
  const normTopics = new Set(norm.topics);

  const results: ProcessMatch[] = [];
  processes.forEach((p, pi) => {
    const pv = vectors[articles.length + pi];
    const overlapTopics = p.topics.filter((t) => normTopics.has(t));
    const topicOverlap = p.topics.length ? overlapTopics.length / p.topics.length : 0;
    const scored = articles.map((a, ai) => {
      const keywords = p.keywords.filter((k) => containsPhrase(normalizedArticles[ai], k));
      return { a, sim: cosine(articleVecs[ai], pv), keywords };
    });
    const best = Math.max(0, ...scored.map((s) => s.sim));
    const allKeywords = new Set(scored.flatMap((s) => s.keywords));
    const kwScore = p.keywords.length ? Math.min(allKeywords.size, 3) / Math.min(p.keywords.length, 3) : 0;
    const score = round(0.25 * topicOverlap + 0.55 * Math.min(1, best * 1.5) + 0.2 * kwScore);
    if (score < threshold) return;
    const top = scored
      .filter((s) => s.sim >= MIN_ARTICLE_SIM || s.keywords.length)
      .sort((x, y) => y.sim + y.keywords.length * 0.1 - (x.sim + x.keywords.length * 0.1))
      .slice(0, maxArticles)
      .map((s) => ({
        number: s.a.number,
        score: round(s.sim),
        keywords: s.keywords,
        excerpt: s.a.text.replace(/\s+/g, ' ').slice(0, 280),
      }));
    const parts = [];
    if (overlapTopics.length) parts.push(`temas en común: ${overlapTopics.join(', ')}`);
    if (allKeywords.size) parts.push(`palabras clave: ${[...allKeywords].join(', ')}`);
    if (top.length) parts.push(`artículos más afines: ${top.map((t) => t.number).join(', ')}`);
    results.push({
      processId: p.id,
      processCode: p.code,
      score,
      topicOverlap: round(topicOverlap),
      articles: top,
      rationale: parts.join('; '),
    });
  });
  return results.sort((a, b) => b.score - a.score);
}

const round = (n: number) => Math.round(n * 1000) / 1000;
