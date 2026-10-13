// Calibra el análisis de texto alterado sin repetir el OCR: usa las palabras ya guardadas.
// Uso: CODIGO=text.flat_background CAMPO=patch node demo/calibrar.mjs <llave del cliente de evaluación> <detalle.local.csv> <tipo>
// El motor debe correr con UKUK_TEXT_OUTLIER o UKUK_PATCH_RATIO bajos para devolver todos los puntajes.
import { readFile } from 'node:fs/promises';
const [key, csv, tipo = 'acta'] = process.argv.slice(2);
const API = 'http://localhost:3000', ENGINE = 'http://localhost:8090';
const label = new Map((await readFile(csv, 'utf8')).split('\n').slice(1).filter(Boolean).map((l) => {
  const [f, et] = l.split(','); return [f.split('/').pop(), et];
}));
const get = (p, raw) => fetch(API + p, { headers: { 'x-api-key': key } }).then((r) => (raw ? r.arrayBuffer() : r.json()));
const docs = [];
for (let off = 0; ; off += 100) {
  const page = await get(`/v1/documents?limit=100&offset=${off}`);
  const items = page.items ?? page;
  docs.push(...items);
  if (items.length < 100) break;
}
const rows = [];
let n = 0;
for (const d of docs) {
  const r = await get(`/v1/documents/${d.id}`);
  const words = r.ocr?.words ?? [];
  const bytes = Buffer.from(await get(`/v1/documents/${d.id}/file`, true));
  const res = await fetch(`${ENGINE}/v1/analyze`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_base64: bytes.toString('base64'), mime_type: r.mime_type, document_type: tipo, ...(words.length ? { ocr_words: words } : {}) }),
  }).then((x) => x.json());
  const CODE = process.env.CODIGO ?? 'text.inconsistent_word', FIELD = process.env.CAMPO ?? 'score';
  const scores = (res.findings ?? []).filter((f) => f.code === CODE).map((f) => f.evidence[FIELD]);
  rows.push({ file: r.filename, sol: /^(sol\d+)_/.exec(r.filename)?.[1], malo: label.get(r.filename) === 'malo', max: Math.max(0, ...scores), words: words.length });
  process.stderr.write(`\r${++n}/${docs.length}`);
}
process.stderr.write('\n');
const sols = new Map();
for (const r of rows) { const s = sols.get(r.sol) ?? { malo: false, max: 0 }; s.malo ||= r.malo; s.max = Math.max(s.max, r.max); sols.set(r.sol, s); }
const pct = (a, b) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0} %)`;
console.log(`Documentos: ${rows.length} · malos: ${rows.filter((r) => r.malo).length} · sin OCR: ${rows.filter((r) => !r.words).length}`);
console.log('umbral | docs malos marcados | docs legítimos marcados | solicitudes con fraude | solicitudes limpias marcadas');
for (const t of (process.env.UMBRALES ?? '1.5,2,2.5,3,3.5,4,5,6').split(',').map(Number)) {
  const m = rows.filter((r) => r.malo), g = rows.filter((r) => !r.malo);
  const sm = [...sols.values()].filter((s) => s.malo), sg = [...sols.values()].filter((s) => !s.malo);
  console.log(`${String(t).padEnd(6)} | ${pct(m.filter((r) => r.max > t).length, m.length).padEnd(19)} | ${pct(g.filter((r) => r.max > t).length, g.length).padEnd(23)} | ${pct(sm.filter((s) => s.max > t).length, sm.length).padEnd(22)} | ${pct(sg.filter((s) => s.max > t).length, sg.length)}`);
}
