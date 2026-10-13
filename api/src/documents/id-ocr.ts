import { OcrWord } from '../engine/engine.types';

/** Lecturas típicas del OCR en campos que solo pueden ser dígitos. */
const AS_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', T: '7', Z: '2', S: '5', B: '8', G: '6', A: '4' };
const digits = (s: string) => s.replace(/[A-Z<]/g, (c) => AS_DIGIT[c] ?? c);
/** Un relleno «<<<<» que el OCR leyó como K, C, E, X…: si casi todo es «<», todo es «<». */
const filler = (s: string) => ((s.match(/</g)?.length ?? 0) >= s.length * 0.6 ? '<'.repeat(s.length) : s);

const normalize = (s: string) =>
  s
    .toUpperCase()
    .replace(/[«‹]/g, '<')
    .replace(/[^A-Z0-9<]/g, '');
const fit = (s: string) => (s.length >= 30 ? s.slice(0, 30) : s.padEnd(30, '<'));

/** Líneas de texto: palabras de la misma página con el centro vertical a la par. */
export function ocrLines(words: OcrWord[]): string[] {
  const sorted = [...words].sort((a, b) => a.page - b.page || a.bbox.y + a.bbox.h / 2 - (b.bbox.y + b.bbox.h / 2));
  const lines: { page: number; yc: number; h: number; words: OcrWord[] }[] = [];
  for (const w of sorted) {
    const yc = w.bbox.y + w.bbox.h / 2;
    const line = lines.find((l) => l.page === w.page && Math.abs(l.yc - yc) < Math.min(l.h, w.bbox.h) * 0.6);
    if (line) line.words.push(w);
    else lines.push({ page: w.page, yc, h: w.bbox.h, words: [w] });
  }
  return lines.map((l) => l.words.sort((a, b) => a.bbox.x - b.bbox.x).map((w) => w.text).join(' '));
}

/**
 * La MRZ TD1 (3 líneas de 30) del DNI, armada desde el OCR y corregida por posición. No se
 * verifica aquí: quien la use debe exigir que sus dígitos de control cuadren.
 * Toma tanto líneas como palabras sueltas: en una foto girada, cada línea de la MRZ suele
 * llegar como una sola «palabra».
 */
export function mrzFromOcr(words: OcrWord[]): string | null {
  const candidates = [...new Set([...ocrLines(words), ...words.map((w) => w.text)].map((s) => normalize(s.replace(/\s+/g, ''))))].filter(
    (s) => s.length >= 24 && s.length <= 36 && (s.includes('<<') || s.startsWith('I<')),
  );
  const l1raw = candidates.find((s) => /^[I1][<K]?P?E?R/.test(s));
  const l2raw = candidates.find((s) => s !== l1raw && /^[0-9OQDUILTZSBGA]{6}.[MFH<]/.test(s));
  const l3raw = candidates.find((s) => s !== l1raw && s !== l2raw && /^[A-Z]{2,}</.test(s));
  if (!l1raw || !l2raw || !l3raw) return null;

  const a = fit(l1raw);
  const l1 = `I<PER${digits(a.slice(5, 13))}${a[13] === '<' ? '<' : digits(a[13])}${digits(a[14])}${filler(a.slice(15))}`;
  const b = fit(l2raw);
  const sex = b[7] === 'H' ? 'M' : b[7];
  const l2 = `${digits(b.slice(0, 7))}${sex}${digits(b.slice(8, 15))}${b.slice(15, 18)}${filler(b.slice(18, 29))}${digits(b[29])}`;
  // En los nombres, «<<<» o más solo aparece en el relleno final: lo que siga es ruido del OCR.
  const l3 = fit(l3raw).replace(/<{3,}.*$/, (m) => '<'.repeat(m.length));
  return [l1, l2, l3].join('\n');
}

/** Número de DNI con su dígito de verificación, tal como se imprime en el frente (12345678-1). */
export function dniFromOcr(words: OcrWord[]): string | null {
  for (const line of ocrLines(words)) {
    const m = /(?:^|\D)(\d{8})\s*-\s*([0-9A-K])(?:\W|$)/.exec(line.toUpperCase());
    if (m) return `${m[1]}-${m[2]}`;
  }
  return null;
}

/** Hallazgos sobre datos que leyó el OCR: un desacuerdo puede ser un error de lectura. */
export const OCR_FIELD_OF: Record<string, string> = {
  'mrz.dni_mismatch': 'dni',
  'dni.check_digit_mismatch': 'dni',
  'dni.invalid_format': 'dni',
};
/** Con este tope, un solo hallazgo alto lleva a «revisar» (30 puntos) y no a «rechazar». */
export const OCR_MAX_CONFIDENCE = 0.86;
