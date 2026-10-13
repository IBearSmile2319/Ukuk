import { OcrWord } from '../engine/engine.types';

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Anchor {
  text: string;
  bbox: Bbox;
  /** Fracción de muestras en que aparece. */
  presence: number;
}

export interface BuildOptions {
  /** Fracción mínima de muestras en que debe aparecer la palabra (0.8 = 80%). */
  minPresence?: number;
  /** Distancia máxima normalizada entre centros para considerar "la misma posición". */
  maxDistance?: number;
  maxAnchors?: number;
}

/** Mayúsculas, sin tildes ni puntuación en los extremos. */
export function normalizeToken(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** Montos, fechas y números cortos cambian de un documento a otro. */
function looksVariable(token: string): boolean {
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(token) || /^\d{4}-\d{2}-\d{2}$/.test(token)) return true;
  return /^[\d.,/:-]+$/.test(token) && token.replace(/\D/g, '').length < 8;
}

const center = (b: Bbox) => ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2 });

interface Occurrence {
  sample: number;
  page: number;
  bbox: Bbox;
}

/**
 * Construye anclas de plantilla a partir de muestras legítimas: palabras que aparecen
 * en al menos `minPresence` de las muestras en una posición parecida, con la caja
 * promedio. Con una o dos muestras se descartan montos y fechas, que suelen variar.
 */
export function buildAnchors(samples: OcrWord[][], opts: BuildOptions = {}): Anchor[] {
  const n = samples.length;
  if (n === 0) return [];
  const minPresence = opts.minPresence ?? 0.8;
  const maxDistance = opts.maxDistance ?? 0.05;
  const needed = Math.max(1, Math.ceil(minPresence * n - 1e-9));

  const byText = new Map<string, Occurrence[]>();
  samples.forEach((words, sample) => {
    for (const w of words) {
      const token = normalizeToken(w.text);
      if (token.length < 2) continue;
      if (n < 3 && looksVariable(token)) continue;
      const list = byText.get(token) ?? [];
      list.push({ sample, page: w.page ?? 1, bbox: w.bbox });
      byText.set(token, list);
    }
  });

  const anchors: (Anchor & { spread: number })[] = [];
  for (const [text, occurrences] of byText) {
    const pending = [...occurrences];
    while (pending.length) {
      const seed = pending.shift()!;
      const cluster: Occurrence[] = [seed];
      const seedC = center(seed.bbox);
      // Como máximo una ocurrencia por muestra: la más cercana a la semilla.
      for (let s = 0; s < n; s++) {
        if (s === seed.sample) continue;
        let best = -1;
        let bestD = Infinity;
        pending.forEach((o, i) => {
          if (o.sample !== s || o.page !== seed.page) return;
          const c = center(o.bbox);
          const d = Math.hypot(c.cx - seedC.cx, c.cy - seedC.cy);
          if (d <= maxDistance && d < bestD) {
            best = i;
            bestD = d;
          }
        });
        if (best >= 0) cluster.push(pending.splice(best, 1)[0]);
      }
      if (cluster.length < needed) continue;
      const avg = (k: keyof Bbox) => cluster.reduce((sum, o) => sum + o.bbox[k], 0) / cluster.length;
      const bbox = { x: avg('x'), y: avg('y'), w: avg('w'), h: avg('h') };
      const c = center(bbox);
      const spread = Math.max(...cluster.map((o) => Math.hypot(center(o.bbox).cx - c.cx, center(o.bbox).cy - c.cy)));
      anchors.push({ text, bbox: roundBbox(bbox), presence: cluster.length / n, spread });
    }
  }

  return anchors
    .sort((a, b) => b.presence - a.presence || a.spread - b.spread || a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
    .slice(0, opts.maxAnchors ?? 200)
    .map(({ spread, ...a }) => a);
}

function roundBbox(b: Bbox): Bbox {
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return { x: r(b.x), y: r(b.y), w: r(b.w), h: r(b.h) };
}
