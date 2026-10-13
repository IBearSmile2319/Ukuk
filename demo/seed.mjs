#!/usr/bin/env node
// Carga un cliente de demostración con datos en los cuatro servicios, usando solo la API.
// Uso: node demo/seed.mjs   (con la API en :3000 y el motor en :8090)
// Variables: UKUK_API (http://localhost:3000), UKUK_ADMIN_TOKEN (dev-admin-token).
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.UKUK_API ?? 'http://localhost:3000';
const ADMIN = process.env.UKUK_ADMIN_TOKEN ?? 'dev-admin-token';
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'engine', 'crates', 'ukuk-names', 'tests', 'fixtures');
const file = (name) => readFile(join(here, name));
const text = async (name) => (await file(name)).toString('utf8');

async function call(method, path, { key, admin, json, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(key ? { 'x-api-key': key } : {}),
      ...(admin ? { 'x-admin-token': ADMIN } : {}),
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(out)}`);
  return out;
}

const step = (msg) => console.log(`• ${msg}`);

// 1. Cliente y llave
const tenant = await call('POST', '/admin/tenants', {
  admin: true,
  json: {
    name: 'Aseguradora Andina (demo)',
    entityType: 'aseguradora',
    businessLines: ['vehicular', 'salud', 'vida'],
    modules: ['documents', 'regulatory', 'plaft', 'claims'],
  },
});
const { key } = await call('POST', `/admin/tenants/${tenant.id}/api-keys`, { admin: true, json: { name: 'demo' } });
step(`Cliente ${tenant.name}`);

// 2. Listas de vigilancia (ficticias) en el motor
for (const [source, fixture, format, category] of [
  ['ofac_sdn', 'sdn_sample.csv', 'ofac_sdn_csv', 'sanction'],
  ['un', 'un_sample.xml', 'un_xml', 'sanction'],
  ['pep_pe', 'pep_sample.jsonl', 'ukuk_jsonl', 'pep'],
]) {
  await call('PUT', `/admin/plaft/watchlists/${source}?format=${format}&category=${category}`, {
    admin: true,
    body: await readFile(join(fixtures, fixture)),
    headers: { 'content-type': 'application/octet-stream' },
  });
}
step('Listas OFAC, ONU y PEP de ejemplo');

// 3. Radar: procesos del cliente y normas de ejemplo
await call('POST', '/v1/regulatory/processes/import', { key, json: { csv: await text('procesos.csv') } });
await call('POST', '/admin/regulatory/norms', { admin: true, json: JSON.parse(await text('normas.json')) });
step('Radar regulatorio: 4 procesos y 3 normas');

// 4. Documentos
const upload = async (name, fields, document_type) => {
  const form = new FormData();
  form.append('file', new Blob([await file(name)], { type: 'image/jpeg' }), name);
  form.append('document_type', document_type);
  form.append('level', 'forensic');
  form.append('fields', JSON.stringify(fields));
  const r = await call('POST', '/v1/documents', { key, body: form });
  step(`Documento ${name}: ${r.verdict} (riesgo ${r.score})`);
};
const boleta = { ruc_emisor: '20999000119', serie_numero: 'B001-00004321', fecha_emision: '2026-03-15', subtotal: '100.00', igv: '18.00' };
await upload('boleta-legitima.jpg', { ...boleta, total: '118.00' }, 'boleta_venta');
await upload('boleta-adulterada.jpg', { ...boleta, total: '918.00' }, 'boleta_venta');
await upload(
  'dni-especimen.jpg',
  // Espécimen alterado: el número impreso termina en 3, pero el dígito del CUI y la MRZ (reverso) son del 45678912.
  {
    dni: '45678913-4',
    apellidos: 'QUISPE MAMANI',
    nombres: 'ROSA ELENA',
    sexo: 'F',
    fecha_nacimiento: '1985-06-14',
    fecha_emision: '2026-03-15',
    fecha_vencimiento: '2034-03-15',
    mrz: (await text('dni-especimen.mrz.txt')).trim(),
  },
  'dni',
);
// DNI azul (versión anterior) de la misma persona: auténtico, pero vencido.
await upload(
  'dni-azul-especimen.jpg',
  {
    dni: '45678912-4',
    apellidos: 'QUISPE MAMANI',
    nombres: 'ROSA ELENA',
    sexo: 'F',
    fecha_nacimiento: '1985-06-14',
    fecha_emision: '2018-03-15',
    fecha_vencimiento: '2026-03-15',
    mrz: (await text('dni-azul-especimen.mrz.txt')).trim(),
  },
  'dni',
);

// 5. PLAFT: carga masiva
const form = new FormData();
form.append('file', new Blob([await file('sujetos.csv')], { type: 'text/csv' }), 'sujetos.csv');
const bulk = await call('POST', '/v1/plaft/subjects/bulk', { key, body: form });
step(`PLAFT: ${JSON.stringify(bulk).slice(0, 120)}`);

// 6. Siniestros: pólizas y una conversación completa en el simulador de WhatsApp
await call('POST', '/v1/claims/policies/import', { key, json: { csv: await text('polizas.csv') } });
const from = '51987654321';
let last;
const say = async (msg) => {
  const r = await call('POST', '/v1/claims/simulator', { key, json: { from, name: 'Rosa', ...msg } });
  last = r.messages.at(-1);
  return r;
};
await say({ text: 'Hola' });
await say({ text: '45678912' });
await say({ reply_id: 'tipo:choque_leve', reply_title: 'Choque leve' });
await say({ text: 'ayer 10:30' });
await say({ location: { lat: -12.1211, lng: -77.0297, name: 'Óvalo de Miraflores' } });
await say({ text: 'Me chocaron por detrás en el óvalo, daño en el parachoques' });
const token = /\/capture\/(\S+)/.exec(last.body ?? '')?.[1];
if (token) {
  const photo = (await file('foto-choque.jpg')).toString('base64');
  await call('POST', `/capture/${token}/photos`, {
    json: { photos: [{ image_base64: photo, mime_type: 'image/jpeg', lat: -12.1214, lng: -77.0301, accuracy: 12, captured_at: new Date().toISOString() }] },
  });
}
await say({ reply_id: 'fotos:listo', reply_title: 'Listo' });
await say({ media: { kind: 'image', mime_type: 'image/jpeg', data_base64: (await file('dni-especimen.jpg')).toString('base64'), filename: 'licencia.jpg' } });
await say({ reply_id: 'confirmar', reply_title: 'Confirmar' });
step(`Siniestro: ${last?.body?.split('\n')[0]}`);

console.log(`\nListo. Entra al portal (http://localhost:5173/#/app con ./dev.sh, o ${API}/#/app) con esta llave:\n\n  ${key}\n`);
