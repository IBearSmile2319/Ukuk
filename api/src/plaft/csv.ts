import { DOC_TYPES, DocType, KINDS, Kind, RELATIONS, Relation, docNumberError } from './regime';

/** CSV RFC 4180: comillas dobles, saltos de línea dentro de comillas, BOM y CRLF. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  // Excel en español guarda con punto y coma.
  const sep = delimiter ?? ((firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

export const CSV_REQUIRED = ['name', 'kind', 'relation', 'doc_type', 'doc_number'] as const;
export const CSV_OPTIONAL = ['birth_date', 'nationality', 'monitor'] as const;

export interface CsvSubject {
  line: number;
  name: string;
  kind: Kind;
  relation: Relation;
  doc_type: DocType;
  doc_number: string;
  birth_date: string | null;
  nationality: string | null;
  monitor: boolean | null;
}

export interface CsvError {
  line: number;
  message: string;
}

export class CsvHeaderError extends Error {}

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Lee la cartera en CSV (cabecera: name,kind,relation,doc_type,doc_number,birth_date,nationality
 * y opcionalmente monitor). Devuelve las filas válidas y los errores por línea.
 */
export function parseSubjectsCsv(text: string, maxRows = 50_000): { subjects: CsvSubject[]; errors: CsvError[] } {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new CsvHeaderError('El archivo está vacío');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const missing = CSV_REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) throw new CsvHeaderError(`Faltan columnas en la cabecera: ${missing.join(', ')}`);
  if (rows.length - 1 > maxRows) throw new CsvHeaderError(`El archivo supera ${maxRows} filas; divídalo en partes`);
  const col = (r: string[], name: string) => {
    const i = header.indexOf(name);
    return i >= 0 ? (r[i] ?? '').trim() : '';
  };

  const subjects: CsvSubject[] = [];
  const errors: CsvError[] = [];
  const seen = new Set<string>();
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const fail = (message: string) => errors.push({ line, message });
    const name = col(r, 'name');
    const kind = col(r, 'kind').toLowerCase() as Kind;
    const relation = col(r, 'relation').toLowerCase() as Relation;
    const docType = col(r, 'doc_type').toUpperCase() as DocType;
    const docNumber = col(r, 'doc_number').toUpperCase().replace(/\s/g, '');
    const birth = col(r, 'birth_date');
    const nationality = col(r, 'nationality').toUpperCase();
    const monitorRaw = col(r, 'monitor').toLowerCase();

    if (name.length < 2) return fail('Falta el nombre');
    if (!KINDS.includes(kind)) return fail(`kind debe ser ${KINDS.join(' o ')}`);
    if (!RELATIONS.includes(relation)) return fail(`relation debe ser uno de: ${RELATIONS.join(', ')}`);
    if (!DOC_TYPES.includes(docType)) return fail(`doc_type debe ser uno de: ${DOC_TYPES.join(', ')}`);
    const docErr = docNumberError(kind, docType, docNumber);
    if (docErr) return fail(docErr);
    if (birth && !validDate(birth)) return fail('birth_date debe tener el formato AAAA-MM-DD');
    if (monitorRaw && !['true', 'false', 'si', 'sí', 'no', '1', '0'].includes(monitorRaw)) return fail('monitor debe ser true o false');
    const key = `${relation}|${docType}|${docNumber}`;
    if (seen.has(key)) return fail('Fila duplicada en el archivo (misma relación y documento)');
    seen.add(key);
    subjects.push({
      line,
      name,
      kind,
      relation,
      doc_type: docType,
      doc_number: docNumber,
      birth_date: birth || null,
      nationality: nationality || null,
      monitor: monitorRaw ? ['true', 'si', 'sí', '1'].includes(monitorRaw) : null,
    });
  });
  return { subjects, errors };
}
