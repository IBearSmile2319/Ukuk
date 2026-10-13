export interface MatchLike {
  source: string;
  entry_id: string;
  score: number;
}

export const matchKey = (m: Pick<MatchLike, 'source' | 'entry_id'>) => `${m.source}\u0000${m.entry_id}`;

/**
 * Coincidencias que aún no se vieron para este sujeto (por fuente + id de la entrada).
 * Si el motor repite una entrada, se queda la de mayor puntaje. Así la revisión
 * nocturna no reabre casos ya resueltos.
 */
export function selectNewMatches<T extends MatchLike>(existingKeys: Iterable<string>, matches: T[]): T[] {
  const existing = new Set(existingKeys);
  const best = new Map<string, T>();
  for (const m of matches) {
    const k = matchKey(m);
    if (existing.has(k)) continue;
    const prev = best.get(k);
    if (!prev || m.score > prev.score) best.set(k, m);
  }
  return [...best.values()];
}
