import { OcrWord } from '../engine/engine.types';

/**
 * Números del documento (fechas, DNI, montos, número de acta). Dos documentos del mismo
 * formato comparten diseño y etiquetas, pero no sus números: por eso la huella de imagen
 * sola no sirve para decir que un documento ya se presentó.
 */
export function numberTokens(words: Pick<OcrWord, 'text'>[]): Set<string> {
  const out = new Set<string>();
  for (const w of words) {
    const digits = w.text.replace(/\D/g, '');
    if (digits.length >= 4) out.add(digits);
  }
  return out;
}

/** null: no hay suficientes números para decidir. */
export function sameNumbers(a: Set<string>, b: Set<string>, minJaccard = 0.6): boolean | null {
  if (a.size < 3 || b.size < 3) return null;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared) >= minJaccard;
}
