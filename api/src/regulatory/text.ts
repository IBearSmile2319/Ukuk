/** Utilidades de texto en español: normalización sin tildes, stopwords y TF-IDF. */

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(
  (
    'a al algo algunas algunos ante antes como con contra cual cuales cuando de del desde donde dos el ella ellas ' +
    'ellos en entre era es esa esas ese eso esos esta estas este esto estos fue fueron ha han hasta hay la las le les ' +
    'lo los mas me mi mismo muy no nos o otra otras otro otros para pero por que quien se segun ser si sin sobre son ' +
    'su sus tal tambien te tiene tienen todo todos tu un una uno unos y ya asi cada caso dicha dicho dichas dichos ' +
    'debe deben debera deberan podra podran sera seran presente articulo articulos numeral literal inciso resolucion ' +
    'mediante conforme respecto acuerdo establecido establecida dispuesto siguiente siguientes demas otro misma'
  ).split(' '),
);

/** Stemming ligero: plurales y la terminación -ciones. Suficiente para comparar temas. */
export function stem(word: string): string {
  if (word.endsWith('ciones')) return word.slice(0, -5) + 'n';
  if (word.length > 5 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export function tokenize(text: string): string[] {
  return normalize(text)
    .split(' ')
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

export type Vector = Map<string, number>;

/** Vectores TF-IDF de un corpus pequeño (los artículos de una norma + los procesos). */
export function tfidfVectors(docs: string[][]): Vector[] {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v: Vector = new Map();
    for (const [t, c] of tf) v.set(t, (1 + Math.log(c)) * (Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1));
    return v;
  });
}

export function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, w] of a) {
    na += w * w;
    const o = b.get(t);
    if (o) dot += w * o;
  }
  for (const w of b.values()) nb += w * w;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** ¿Aparece la frase (sin tildes, por palabras completas) en el texto normalizado? */
export function containsPhrase(normalizedText: string, phrase: string): boolean {
  const p = normalize(phrase);
  return !!p && ` ${normalizedText} `.includes(` ${p} `);
}

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

/** "1 de enero de 2027", "1° de enero del 2027", "primero de enero de 2027" → 2027-01-01. */
export function parseSpanishDate(normalizedText: string): string | null {
  const m = /\b(\d{1,2}|primero)\s*(?:o\s+)?de\s+([a-z]+)\s+(?:de|del)\s+(\d{4})\b/.exec(normalizedText);
  if (!m || !MONTHS[m[2]]) return null;
  const day = m[1] === 'primero' ? 1 : Number(m[1]);
  if (day < 1 || day > 31) return null;
  return isoDate(Number(m[3]), MONTHS[m[2]], day);
}

export function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Días hábiles aproximados: salta sábados y domingos. TODO: feriados nacionales. */
export function addBusinessDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}
