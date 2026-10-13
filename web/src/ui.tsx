import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, qs, type Verdict } from './api';

// ---------------------------------------------------------------- rutas (hash)

export function useHash(): string {
  const get = () => window.location.hash.replace(/^#/, '') || '/';
  const [hash, setHash] = useState(get);
  useEffect(() => {
    const on = () => setHash(get());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export const navigate = (path: string) => {
  window.location.hash = path;
};

// ---------------------------------------------------------------- datos

type Query = Record<string, string | number | boolean | null | undefined>;

export function useApi<T>(path: string | null, query?: Query) {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: !!path });
  const [n, setN] = useState(0);
  const key = path ? path + qs(query) : null;
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState((s) => ({ data: s.data, loading: true }));
    api<T>(path, { query }).then(
      (data) => live && setState({ data, loading: false }),
      (error: ApiError) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

/** Envío de formularios con estado de carga y error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

// ---------------------------------------------------------------- preferencia de animación

export type MotionPref = 'full' | 'compact' | 'off';
const MOTION_KEY = 'ukuk.animacion';

const readPref = (): MotionPref => {
  try {
    const v = localStorage.getItem(MOTION_KEY);
    return v === 'compact' || v === 'off' ? v : 'full';
  } catch {
    return 'full';
  }
};

export function useMotionPref(): [MotionPref, (p: MotionPref) => void, boolean] {
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const [pref, setPrefState] = useState<MotionPref>(readPref);
  const [reduced, setReduced] = useState(!!mq?.matches);
  useEffect(() => {
    const onPref = () => setPrefState(readPref());
    const onMq = () => setReduced(!!mq?.matches);
    window.addEventListener('ukuk:motion', onPref);
    mq?.addEventListener('change', onMq);
    return () => {
      window.removeEventListener('ukuk:motion', onPref);
      mq?.removeEventListener('change', onMq);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setPref = (p: MotionPref) => {
    try {
      localStorage.setItem(MOTION_KEY, p);
    } catch {
      /* sin almacenamiento: vale solo para esta pestaña */
    }
    setPrefState(p);
    window.dispatchEvent(new Event('ukuk:motion'));
  };
  return [pref, setPref, reduced];
}

// ---------------------------------------------------------------- formatos

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];
const TZ = 'America/Lima';

export function limaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

export function fmtDay(s: string | null | undefined): string {
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return fmtDay(d.toLocaleDateString('en-CA', { timeZone: TZ }));
}

export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const time = d.toLocaleTimeString('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fmtDay(s)}, ${time}`;
}

/** Días calendario hasta una fecha (negativo si ya pasó). */
export function daysUntil(s: string | null | undefined): number | null {
  if (!s) return null;
  return Math.ceil((new Date(s).getTime() - Date.now()) / 86_400_000);
}

const pen = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' });
const usd = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'USD' });
export const fmtSoles = (n: number) => pen.format(n);
export const fmtUsd = (n: number) => usd.format(n);
export const fmtPct = (n: number) => `${Math.round(n * 100)} %`;

export const humanize = (s: string) => {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const labelOf = (map: Record<string, string>, v: string | null | undefined) => (v ? (map[v] ?? humanize(v)) : '—');

// ---------------------------------------------------------------- vocabulario

export const MODULES: Record<string, string> = {
  documents: 'Verificación documental',
  regulatory: 'Radar regulatorio',
  plaft: 'PLAFT',
  claims: 'Siniestros por WhatsApp',
};

export const ENTITY_TYPES: Record<string, string> = {
  aseguradora: 'Aseguradora',
  corredor: 'Corredor de seguros',
  afocat: 'AFOCAT',
  banco: 'Banco',
  caja: 'Caja municipal o rural',
  cooperativa: 'Cooperativa',
  financiera: 'Financiera',
  fintech: 'Fintech',
  casa_cambio: 'Casa de cambio',
  remesadora: 'Remesadora',
  inmobiliaria: 'Inmobiliaria',
  notaria: 'Notaría',
  casino: 'Casino o apuestas',
  otro: 'Otro',
};

export const DOC_TYPES: Record<string, string> = {
  dni: 'DNI',
  boleta_pago: 'Boleta de pago',
  recibo_servicio: 'Recibo de servicio',
  factura: 'Factura',
  boleta_venta: 'Boleta de venta',
  informe_medico: 'Informe médico',
  receta: 'Receta',
  acta: 'Acta',
  certificado: 'Certificado',
  other: 'Otro',
};

export const LEVELS: Record<string, string> = {
  extraction: 'Extracción',
  verification: 'Verificación',
  forensic: 'Forense con informe',
};

export const LAYERS: Record<string, string> = {
  quality: 'Calidad y legibilidad',
  classification: 'Clasificación',
  extraction: 'Extracción',
  consistency: 'Consistencia interna',
  forensics: 'Forense de imagen',
  template: 'Plantilla de referencia',
  external: 'Validación externa',
  reuse: 'Reuso',
};

export const SEVERITIES: Record<string, string> = {
  info: 'Informativo',
  low: 'Bajo',
  medium: 'Medio',
  high: 'Alto',
  critical: 'Crítico',
};

export const VERDICTS: Record<string, string> = { aprobar: 'Aprobar', revisar: 'Revisar', rechazar: 'Rechazar' };

export const FIELDS: Record<string, string> = {
  total: 'Total',
  subtotal: 'Subtotal',
  igv: 'IGV',
  fecha_emision: 'Fecha de emisión',
  ruc_emisor: 'RUC del emisor',
  serie_numero: 'Serie y número',
  dni: 'DNI',
  mrz: 'MRZ',
  nombres: 'Nombres',
  apellidos: 'Apellidos',
  sexo: 'Sexo',
  nacionalidad: 'Nacionalidad',
  fecha_nacimiento: 'Fecha de nacimiento',
  fecha_vencimiento: 'Fecha de vencimiento',
};

// ---------------------------------------------------------------- piezas visuales

export function Bear({ size = 32, inverse = false, title }: { size?: number; inverse?: boolean; title?: string }) {
  const ink = inverse ? '#F1E2C4' : '#23201B';
  const cream = inverse ? '#23201B' : '#F1E2C4';
  return (
    <svg viewBox="0 0 200 200" width={size} height={size} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <circle cx="50" cy="56" r="24" fill={ink} />
      <circle cx="150" cy="56" r="24" fill={ink} />
      <ellipse cx="100" cy="112" rx="76" ry="70" fill={ink} />
      <circle cx="72" cy="100" r="19" fill={cream} />
      <circle cx="128" cy="100" r="19" fill={cream} />
      <rect x="88" y="92" width="24" height="8" rx="4" fill={cream} />
      <circle cx="74" cy="104" r="6.5" fill={ink} />
      <circle cx="126" cy="104" r="6.5" fill={ink} />
      <circle cx="76" cy="101.5" r="2" fill={cream} />
      <circle cx="128" cy="101.5" r="2" fill={cream} />
      <ellipse cx="100" cy="145" rx="30" ry="22" fill={cream} />
      <ellipse cx="100" cy="135" rx="11" ry="7.5" fill={ink} />
      <path
        d="M100 142 V150 M100 150 Q93 157 86 152 M100 150 Q107 157 114 152"
        fill="none"
        stroke={ink}
        strokeWidth="3.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Wordmark({ inverse = false, size = 30 }: { inverse?: boolean; size?: number }) {
  return (
    <span className={`wordmark${inverse ? ' is-inverse' : ''}`} style={{ fontSize: size * 0.9 }}>
      <Bear size={size} inverse={inverse} />
      <span>ukuk</span>
    </span>
  );
}

/** Progreso escalonado: cada etapa es un peldaño que se llena. */
export function StepProgress({ done, total, busy = false }: { done: number; total: number; busy?: boolean }) {
  return (
    <span className={`steps${busy ? ' is-busy' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={i < done ? 'on' : i === done && busy ? 'next' : ''} style={{ height: 5 + i * 3 }} />
      ))}
    </span>
  );
}

export type Tone = 'red' | 'amber' | 'green' | 'blue' | 'ink' | 'muted';

export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export const verdictTone = (v: Verdict | string | null | undefined): Tone =>
  v === 'rechazar' ? 'red' : v === 'revisar' ? 'amber' : v === 'aprobar' ? 'green' : 'muted';

export const severityTone = (s: string): Tone =>
  s === 'critical' || s === 'high' || s === 'medium' ? 'red' : s === 'low' ? 'amber' : 'muted';

export function VerdictBadge({ verdict }: { verdict: string | null | undefined }) {
  if (!verdict) return <Badge>Sin veredicto</Badge>;
  return <Badge tone={verdictTone(verdict)}>{labelOf(VERDICTS, verdict)}</Badge>;
}

/** Puntaje de riesgo en su escala: aprobar < 30 ≤ revisar < 70 ≤ rechazar. */
export function ScoreScale({ score, verdict }: { score: number; verdict: string | null }) {
  return (
    <div className="score">
      <div className="score-num">
        <strong>{score}</strong>
        <span>/100 de riesgo</span>
      </div>
      <div className="score-scale" aria-hidden="true">
        <span className="z-green" style={{ width: '30%' }} />
        <span className="z-amber" style={{ width: '40%' }} />
        <span className="z-red" style={{ width: '30%' }} />
        <i style={{ left: `${Math.min(100, Math.max(0, score))}%` }} />
      </div>
      <div className="score-legend" aria-hidden="true">
        <span>Aprobar</span>
        <span>Revisar</span>
        <span>Rechazar</span>
      </div>
      <p className="score-verdict">
        Recomendación: <VerdictBadge verdict={verdict} />
      </p>
    </div>
  );
}

export function ErrorNote({ error, children }: { error?: ApiError | null; children?: ReactNode }) {
  if (!error && !children) return null;
  const msg =
    error?.status === 403 ? 'Este servicio no está activo en el contrato de su entidad. Si lo necesita, pídalo a su ejecutivo de Ukuk.' : error?.message;
  return (
    <p className="note note-error" role="alert">
      {children ?? msg}
    </p>
  );
}

export function Loading({ text = 'Cargando…' }: { text?: string }) {
  return (
    <p className="loading" role="status">
      <StepProgress done={0} total={4} busy />
      {text}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field${wide ? ' field-wide' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Tabs({ items, current }: { items: { href: string; label: string; count?: number | null }[]; current: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    // En celulares la barra se desplaza: la pestaña activa debe quedar a la vista.
    const nav = ref.current;
    const el = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && el) nav.scrollLeft = el.offsetLeft - nav.clientWidth / 2 + el.clientWidth / 2;
  }, [current]);
  return (
    <nav className="tabs" aria-label="Secciones" ref={ref}>
      {items.map((t) => (
        <a key={t.href} href={`#${t.href}`} aria-current={current === t.href ? 'page' : undefined}>
          {t.label}
          {t.count ? <span className="tab-count">{t.count}</span> : null}
        </a>
      ))}
    </nav>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Pager({ total, limit, offset, onPage }: { total: number; limit: number; offset: number; onPage: (o: number) => void }) {
  if (total <= limit) return null;
  return (
    <div className="pager">
      <button type="button" className="btn btn-quiet" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>
        Anteriores
      </button>
      <span>
        {offset + 1}–{Math.min(total, offset + limit)} de {total}
      </span>
      <button type="button" className="btn btn-quiet" disabled={offset + limit >= total} onClick={() => onPage(offset + limit)}>
        Siguientes
      </button>
    </div>
  );
}

/** Lista de pares dato/valor. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
