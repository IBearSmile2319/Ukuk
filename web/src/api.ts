// Cliente mínimo de la API de Ukuk. Mismo origen en producción; Vite reenvía en desarrollo.

const KEY = 'ukuk.apiKey';
const USER = 'ukuk.user';

const read = (k: string) => {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* almacenamiento bloqueado: la sesión dura lo que la pestaña */
  }
};

export const session = {
  key: read(KEY),
  user: read(USER),
  save(key: string, user: string) {
    this.key = key;
    this.user = user;
    write(KEY, key);
    write(USER, user || null);
  },
  clear() {
    this.key = '';
    write(KEY, null);
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown = null,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function qs(q?: Query): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

function messageOf(status: number, body: any): string {
  const m = body?.message;
  if (Array.isArray(m)) return m.join('. ');
  if (typeof m === 'string' && m) return m;
  if (status === 403) return 'Este servicio no está activo en su contrato.';
  if (status === 404) return 'No se encontró el recurso.';
  if (status >= 500) return 'La API respondió con un error. Intente de nuevo en unos minutos.';
  return `Error ${status}`;
}

async function request(path: string, init: RequestInit & { query?: Query } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (session.key) headers.set('x-api-key', session.key);
  if (session.user) headers.set('x-ukuk-user', session.user);
  let res: Response;
  try {
    res = await fetch(path + qs(init.query), { ...init, headers });
  } catch {
    throw new ApiError(0, 'No se pudo conectar con la API. Revise su conexión.');
  }
  if (res.ok) return res;
  const body = await res.json().catch(() => null);
  if (res.status === 401 && path.startsWith('/v1/')) {
    session.clear();
    window.dispatchEvent(new Event('ukuk:logout'));
  }
  throw new ApiError(res.status, messageOf(res.status, body), body);
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; form?: FormData; query?: Query } = {},
): Promise<T> {
  const init: RequestInit & { query?: Query } = { method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'), query: opts.query };
  if (opts.form) init.body = opts.form;
  else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await request(path, init);
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? res.json() : res.text()) as Promise<T>;
}

export async function apiBlob(path: string, query?: Query): Promise<Blob> {
  return (await request(path, { query })).blob();
}

/** Descarga un archivo protegido por la llave (CSV, PDF) sin exponerla en la URL. */
export async function download(path: string, filename: string, query?: Query) {
  const url = URL.createObjectURL(await apiBlob(path, query));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- Tipos de las respuestas que usa la interfaz ----------

export type Module = 'documents' | 'regulatory' | 'plaft' | 'claims';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type Verdict = 'aprobar' | 'revisar' | 'rechazar';

export interface Account {
  id: string;
  name: string;
  entityType: string;
  modules: Module[];
  businessLines: string[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Region extends Box {
  page: number;
}

export interface Finding {
  code: string;
  layer: string;
  severity: Severity;
  confidence: number;
  message: string;
  region: Region | null;
  evidence: any;
}

export interface OcrWord {
  text: string;
  confidence: number;
  page?: number;
  bbox: Box;
}

export interface Stage {
  stage: string;
  at: string;
  [k: string]: unknown;
}

export interface DocReport {
  id?: string;
  status: string;
  document_type: string | null;
  issuer: string | null;
  level: string;
  external_ref?: string | null;
  filename: string | null;
  mime_type: string;
  score: number | null;
  verdict: Verdict | null;
  retake_required: boolean;
  confidence_note: string | null;
  findings: Finding[];
  extracted_fields: Record<string, unknown> | null;
  provided_fields?: Record<string, unknown> | null;
  external?: { source: string; status: string; request: unknown; response: unknown; checked_at: string; findings: Finding[] }[] | null;
  template?: any;
  ocr?: { provider: string; words: OcrWord[] } | null;
  explanation?: any;
  progress?: Stage[];
  review?: { decision: string; notes: string | null; by: string; at: string } | null;
  can_add_to_templates?: boolean;
  template_sample?: boolean;
  error?: string | null;
  created_at: string;
  completed_at?: string | null;
}

export interface DocListItem {
  id: string;
  status: string;
  document_type: string | null;
  level: string;
  filename: string | null;
  mime_type: string;
  score: number | null;
  verdict: Verdict | null;
  review_decision: string | null;
  external_ref: string | null;
  created_at: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Statement {
  month: string;
  lines: { service: Module; description: string; quantity: number; unitPrice: number; amount: number }[];
  subtotal: number;
  bundleDiscountRate: number;
  bundleDiscount: number;
  total: number;
  passthroughUsd: { unit: string; quantity: number; amount: number }[];
}

export interface SimMessage {
  id: string;
  direction: 'in' | 'out';
  type: string;
  body: string | null;
  payload: any;
  file_id: string | null;
  at: string;
}

export interface SimState {
  conversation: { id: string; status: string; claim_id: string | null; message_count: number } | null;
  messages: SimMessage[];
}
