#!/usr/bin/env node
// Mide qué detecta Ukuk en una carpeta de documentos con resultado conocido.
// Todo corre en tu máquina (API en :3000) y solo imprime cifras agregadas, sin datos personales.
//
// Uso:
//   node demo/evaluar.mjs <carpeta> --tipo acta [--etiquetas etiquetas.csv] [--detalle salida.csv]
//
// Etiquetas: un CSV con columnas archivo,etiqueta (etiqueta = bueno | malo), o carpetas llamadas
// "buenos" y "malos" dentro de <carpeta>. Sin etiquetas solo se reporta la distribución.
// --detalle escribe un CSV local con el resultado por archivo (no se imprime en pantalla).
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';

const API = process.env.UKUK_API ?? 'http://localhost:3000';
const ADMIN = process.env.UKUK_ADMIN_TOKEN ?? 'dev-admin-token';
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.pdf': 'application/pdf' };

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!dir) {
  console.error('Uso: node demo/evaluar.mjs <carpeta> --tipo acta [--etiquetas etiquetas.csv] [--detalle salida.csv]');
  process.exit(1);
}
const tipo = opt('tipo') ?? 'other';

async function files(d) {
  const out = [];
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (MIME[extname(e.name).toLowerCase()]) out.push(p);
  }
  return out;
}

async function labels() {
  const map = new Map();
  const csv = opt('etiquetas');
  if (csv) {
    for (const line of (await readFile(csv, 'utf8')).split(/\r?\n/).slice(1)) {
      const [file, label] = line.split(/[,;]/).map((s) => s?.trim());
      if (file && /^(bueno|malo)$/i.test(label ?? '')) map.set(basename(file), label.toLowerCase());
    }
  }
  return map;
}

const labelFor = (path, map) => {
  if (map.has(basename(path))) return map.get(basename(path));
  const parts = relative(dir, path).split(sep).map((s) => s.toLowerCase());
  if (parts.includes('malos')) return 'malo';
  if (parts.includes('buenos')) return 'bueno';
  return null;
};

async function call(method, path, init = {}) {
  const res = await fetch(`${API}${path}`, { method, ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(body)?.slice(0, 200)}`);
  return body;
}

// Un cliente aparte para que la evaluación no se mezcle con otros datos.
const json = { 'content-type': 'application/json', 'x-admin-token': ADMIN };
const tenant = await call('POST', '/admin/tenants', {
  headers: json,
  body: JSON.stringify({ name: `Evaluación ${new Date().toISOString().slice(0, 16)}`, entityType: 'otro', modules: ['documents'] }),
});
const { key } = await call('POST', `/admin/tenants/${tenant.id}/api-keys`, { headers: json, body: JSON.stringify({ name: 'evaluacion' }) });

const list = await files(dir);
const map = await labels();
const rows = [];
let done = 0;
async function analyze(path) {
  const form = new FormData();
  form.append('file', new Blob([await readFile(path)], { type: MIME[extname(path).toLowerCase()] }), basename(path));
  form.append('document_type', tipo);
  form.append('level', 'forensic');
  try {
    const r = await call('POST', '/v1/documents', { headers: { 'x-api-key': key }, body: form });
    rows.push({ path, label: labelFor(path, map), verdict: r.verdict, score: r.score, codes: r.findings.filter((f) => f.severity !== 'info').map((f) => f.code) });
  } catch (err) {
    rows.push({ path, label: labelFor(path, map), verdict: 'error', score: null, codes: [], error: String(err.message).slice(0, 120) });
  }
  process.stderr.write(`\r${++done}/${list.length}`);
}
// ponytail: concurrencia fija de 3; subirla si el motor y el OCR aguantan más.
for (let i = 0; i < list.length; i += 3) await Promise.all(list.slice(i, i + 3).map(analyze));
process.stderr.write('\n');

const count = (xs, f) => xs.filter(f).length;
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '—');
const top = (xs, n = 8) =>
  Object.entries(xs.flatMap((r) => [...new Set(r.codes)]).reduce((m, c) => ((m[c] = (m[c] ?? 0) + 1), m), {}))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([c, k]) => `  ${String(k).padStart(4)}  ${c}`)
    .join('\n') || '  (ninguno)';

const flagged = (r) => r.verdict === 'revisar' || r.verdict === 'rechazar';
console.log(`\nDocumentos: ${rows.length} (tipo ${tipo}) · errores: ${count(rows, (r) => r.verdict === 'error')}`);
for (const v of ['aprobar', 'revisar', 'rechazar']) console.log(`  ${v.padEnd(9)} ${count(rows, (r) => r.verdict === v)}`);

const bad = rows.filter((r) => r.label === 'malo');
const good = rows.filter((r) => r.label === 'bueno');
if (bad.length || good.length) {
  console.log(`\nCon fraude confirmado: ${bad.length}`);
  console.log(`  detectados (revisar o rechazar): ${count(bad, flagged)} → ${pct(count(bad, flagged), bad.length)}`);
  console.log(`  rechazados:                      ${count(bad, (r) => r.verdict === 'rechazar')}`);
  console.log(`  se escaparon (aprobar):          ${count(bad, (r) => r.verdict === 'aprobar')}`);
  console.log(`Legítimos: ${good.length}`);
  console.log(`  falsas alarmas (revisar o rechazar): ${count(good, flagged)} → ${pct(count(good, flagged), good.length)}`);
  console.log(`\nHallazgos en los fraudes detectados:\n${top(bad.filter(flagged))}`);
  console.log(`Hallazgos en las falsas alarmas:\n${top(good.filter(flagged))}`);
} else {
  console.log(`\nHallazgos más frecuentes:\n${top(rows)}`);
  console.log('\n(Sin etiquetas no se puede medir la detección: usa --etiquetas o carpetas buenos/malos.)');
}

const detalle = opt('detalle');
if (detalle) {
  const csv = ['archivo,etiqueta,veredicto,riesgo,hallazgos', ...rows.map((r) => [relative(dir, r.path), r.label ?? '', r.verdict, r.score ?? '', r.codes.join(' ')].join(','))];
  await writeFile(detalle, csv.join('\n') + '\n');
  console.log(`\nDetalle por archivo en ${detalle} (solo local).`);
}
