import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { api, ApiError, session, type Account, type Module, type Statement } from '../api';
import {
  Badge,
  Bear,
  ENTITY_TYPES,
  ErrorNote,
  Facts,
  Loading,
  MODULES,
  PageHead,
  Wordmark,
  fmtDateTime,
  fmtSoles,
  fmtUsd,
  humanize,
  labelOf,
  limaToday,
  useAction,
  useApi,
} from '../ui';
import { Claims } from './Claims';
import { Documents } from './Documents';
import { Plaft } from './Plaft';
import { Regulatory } from './Regulatory';

export function Portal({ path }: { path: string }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [checking, setChecking] = useState(!!session.key);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const onLogout = () => {
      setAccount(null);
      setExpired(true);
    };
    window.addEventListener('ukuk:logout', onLogout);
    return () => window.removeEventListener('ukuk:logout', onLogout);
  }, []);

  useEffect(() => {
    if (!session.key) return;
    api<Account>('/v1/account')
      .then(setAccount)
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    document.title = account ? `ukuk — ${account.name}` : 'ukuk — Ingresar';
  }, [account]);

  if (checking)
    return (
      <div className="login-form">
        <Loading text="Verificando su sesión…" />
      </div>
    );
  if (!account)
    return (
      <Login
        expired={expired}
        onLogin={(a) => {
          setExpired(false);
          setAccount(a);
        }}
      />
    );
  return <Shell account={account} path={path} />;
}

function Login({ onLogin, expired }: { onLogin: (a: Account) => void; expired: boolean }) {
  const [key, setKey] = useState('');
  const [user, setUser] = useState(session.user);
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const k = key.trim();
    if (!k) return setError('Pegue la llave de API que le entregó su administrador.');
    setBusy(true);
    setError(null);
    session.key = k;
    session.user = user.trim();
    try {
      const acc = await api<Account>('/v1/account');
      session.save(k, user.trim());
      onLogin(acc);
    } catch (err) {
      session.key = '';
      const status = err instanceof ApiError ? err.status : 0;
      setError(status === 401 ? 'La llave no es válida o fue revocada. Revise que la copió completa.' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login-art">
        <a href="#/" aria-label="Volver a la portada">
          <Wordmark inverse size={40} />
        </a>
        <p>Cada hallazgo, marcado y explicado. La decisión es de su equipo.</p>
      </div>
      <div className="login-form">
        <form onSubmit={submit} className="form">
          <h1>Ingresar al portal</h1>
          {expired && !error && <p className="note note-warn">Su sesión terminó o la llave fue revocada. Ingrese de nuevo.</p>}
          <label className="field">
            <span className="field-label">Llave de API</span>
            <input
              type={show ? 'text' : 'password'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="uk_live_…"
              required
            />
            <span className="field-hint">
              <label className="check">
                <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Mostrar la llave
              </label>
            </span>
          </label>
          <label className="field">
            <span className="field-label">Su correo (opcional)</span>
            <input type="email" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="email" placeholder="analista@entidad.pe" />
            <span className="field-hint">Queda en el registro de auditoría junto a cada decisión que tome.</span>
          </label>
          {error && (
            <p className="note note-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary btn-lg" disabled={busy}>
            {busy ? 'Verificando…' : 'Ingresar'}
          </button>
          <p className="muted small">La llave se guarda solo en este navegador. Use «Salir» en equipos compartidos.</p>
        </form>
      </div>
    </main>
  );
}

const NAV: { href: string; label: string; module?: Module; sub?: boolean }[] = [
  { href: '/app', label: 'Resumen' },
  { href: '/app/documentos', label: 'Documentos', module: 'documents' },
  { href: '/app/plaft', label: 'PLAFT', module: 'plaft' },
  { href: '/app/radar', label: 'Radar regulatorio', module: 'regulatory' },
  { href: '/app/siniestros', label: 'Siniestros', module: 'claims' },
  { href: '/app/siniestros/simulador', label: 'Simulador de WhatsApp', module: 'claims', sub: true },
  { href: '/app/cuenta', label: 'Cuenta' },
];

function Shell({ account, path }: { account: Account; path: string }) {
  const [open, setOpen] = useState(false);
  const route = path.split('?')[0].replace(/\/+$/, '') || '/app';
  const parts = route.split('/').slice(2); // tras "/app"
  useEffect(() => {
    setOpen(false);
    window.scrollTo(0, 0);
  }, [route]);

  const items = NAV.filter((n) => !n.module || account.modules.includes(n.module));
  const current = items
    .filter((n) => route === n.href || route.startsWith(n.href + '/'))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  const logout = () => {
    session.clear();
    window.location.hash = '/';
    window.location.reload();
  };

  const need = (m: Module, el: ReactElement) => (account.modules.includes(m) ? el : <NotInContract module={m} />);
  let page: ReactElement;
  switch (parts[0]) {
    case undefined:
      page = <Summary account={account} />;
      break;
    case 'documentos':
      page = need('documents', <Documents parts={parts.slice(1)} path={path} />);
      break;
    case 'plaft':
      page = need('plaft', <Plaft parts={parts.slice(1)} />);
      break;
    case 'radar':
      page = need('regulatory', <Regulatory parts={parts.slice(1)} />);
      break;
    case 'siniestros':
      page = need('claims', <Claims parts={parts.slice(1)} />);
      break;
    case 'cuenta':
      page = <AccountPage account={account} />;
      break;
    default:
      page = (
        <div className="empty">
          No encontramos esta página. <a href="#/app">Volver al resumen</a>
        </div>
      );
  }

  return (
    <div className="app">
      <aside className={`side${open ? ' is-open' : ''}`}>
        <div className="side-brand">
          <a href="#/app" aria-label="ukuk, resumen">
            <Wordmark inverse size={30} />
          </a>
          <button type="button" className="btn btn-ghost-inverse side-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Cerrar' : 'Menú'}
          </button>
        </div>
        <div className="side-tenant">
          <strong>{account.name}</strong>
          {labelOf(ENTITY_TYPES, account.entityType)}
        </div>
        <nav aria-label="Portal">
          {items.map((n) => (
            <a key={n.href} href={`#${n.href}`} className={n.sub ? 'sub' : undefined} aria-current={current === n.href ? 'page' : undefined}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          {session.user && <span>Sesión de {session.user}</span>}
          <button type="button" className="btn btn-ghost-inverse" onClick={logout}>
            Salir
          </button>
        </div>
      </aside>
      <main className="main" id="contenido">
        {page}
      </main>
    </div>
  );
}

function NotInContract({ module }: { module: Module }) {
  return (
    <div className="panel">
      <h1 className="panel-title">{MODULES[module]}</h1>
      <p>Este servicio no está activo en el contrato de su entidad. Si quiere probarlo, pídalo a su ejecutivo de Ukuk.</p>
    </div>
  );
}

// ---------------------------------------------------------------- resumen

interface InboxItem {
  n: number | null;
  title: string;
  hint: string;
  href: string;
  action: string;
}

function useInbox(modules: Module[]) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  useEffect(() => {
    let live = true;
    const safe = <T,>(p: Promise<T>) => p.catch(() => null);
    (async () => {
      const out: InboxItem[] = [];
      const jobs: Promise<void>[] = [];
      if (modules.includes('documents'))
        jobs.push(
          Promise.all(['revisar', 'rechazar'].map((v) => safe(api('/v1/documents', { query: { verdict: v, limit: 100 } })))).then((rs) => {
            const pending = rs.flatMap((r: any) => r?.items ?? []).filter((d: any) => !d.review_decision).length;
            out.push({
              n: rs.every((r) => r === null) ? null : pending,
              title: pending === 1 ? 'documento espera revisión' : 'documentos esperan revisión',
              hint: 'Veredicto revisar o rechazar, sin decisión del analista',
              href: '#/app/documentos?pendientes=1',
              action: 'Revisar documentos',
            });
          }),
        );
      if (modules.includes('plaft'))
        jobs.push(
          safe(api('/v1/plaft/cases', { query: { status: 'abierto', limit: 1 } })).then((r: any) => {
            out.push({
              n: r?.total ?? null,
              title: r?.total === 1 ? 'caso PLAFT abierto' : 'casos PLAFT abiertos',
              hint: 'Coincidencias en listas que necesitan su decisión',
              href: '#/app/plaft/casos',
              action: 'Ver casos',
            });
          }),
        );
      if (modules.includes('claims'))
        jobs.push(
          Promise.all([safe(api('/v1/claims', { query: { status: 'revision_analista' } })), safe(api('/v1/claims/alerts'))]).then(
            ([review, alerts]: any[]) => {
              out.push({
                n: review ? review.length : null,
                title: review?.length === 1 ? 'siniestro de riesgo alto espera al analista' : 'siniestros de riesgo alto esperan al analista',
                hint: 'Antes de pasar al ajustador',
                href: '#/app/siniestros',
                action: 'Ver siniestros',
              });
              out.push({
                n: alerts ? alerts.length : null,
                title: alerts?.length === 1 ? 'alerta de plazo SBS' : 'alertas de plazo SBS',
                hint: 'Días 20, 25 y 28, y siniestros consentidos',
                href: '#/app/siniestros/alertas',
                action: 'Ver alertas',
              });
            },
          ),
        );
      if (modules.includes('regulatory'))
        jobs.push(
          Promise.all([
            safe(api('/v1/regulatory/impact-matrix', { query: { status: 'pendiente' } })),
            safe(api('/v1/regulatory/digest', { query: { date: limaToday() } })),
          ]).then(([rows, digest]: any[]) => {
            const n = rows ? new Set(rows.map((r: any) => r.impact_id)).size : null;
            out.push({
              n,
              title: n === 1 ? 'impacto regulatorio pendiente' : 'impactos regulatorios pendientes',
              hint: 'Normas que tocan sus políticas y procesos',
              href: '#/app/radar/matriz',
              action: 'Abrir matriz',
            });
            out.push({
              n: digest ? digest.consultations.length : null,
              title: digest?.consultations.length === 1 ? 'proyecto de norma abierto a comentarios' : 'proyectos de norma abiertos a comentarios',
              hint: 'Puede enviar comentarios a la SBS antes del plazo',
              href: '#/app/radar',
              action: 'Ver resumen diario',
            });
          }),
        );
      await Promise.all(jobs);
      const order = ['#/app/documentos?pendientes=1', '#/app/plaft/casos', '#/app/siniestros', '#/app/siniestros/alertas', '#/app/radar/matriz', '#/app/radar'];
      if (live) setItems(out.sort((a, b) => order.indexOf(a.href) - order.indexOf(b.href)));
    })();
    return () => {
      live = false;
    };
  }, [modules]);
  return items;
}

function Summary({ account }: { account: Account }) {
  const inbox = useInbox(account.modules);
  const month = limaToday().slice(0, 7);
  return (
    <>
      <PageHead
        title="Resumen"
        sub={
          <>
            {account.name}. {labelOf(ENTITY_TYPES, account.entityType)}
            {account.businessLines.length ? `, líneas: ${account.businessLines.join(', ')}` : ''}.
          </>
        }
      />
      <div className="grid-2">
        <section className="panel" aria-labelledby="pend">
          <h2 id="pend">Pendientes</h2>
          {!inbox ? (
            <Loading />
          ) : (
            <ul className="inbox">
              {inbox.map((i) => (
                <li key={i.href + i.title}>
                  <span className={`inbox-n${i.n === 0 ? ' is-zero' : ''}`}>{i.n ?? '—'}</span>
                  <span className="inbox-text">
                    <strong>{i.n === null ? `No se pudo cargar: ${i.title}` : i.title}</strong>
                    <span>{i.hint}</span>
                  </span>
                  <a className="btn btn-quiet btn-sm" href={i.href}>
                    {i.action}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
        <StatementPanel initialMonth={month} compact />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- estado de cuenta

const USAGE: Record<string, string> = {
  extraction: 'Documentos: extracción',
  verification: 'Documentos: verificación',
  forensic: 'Documentos: forense con informe',
  onboarding_check: 'Consultas de alta',
  monitored_record_month: 'Registros monitoreados en el mes',
  claim: 'Siniestros gestionados',
  'ajuste a mínimo mensual': 'Ajuste al mínimo mensual',
  whatsapp_message: 'Mensajes de WhatsApp',
};
const usageLabel = (d: string) => USAGE[d] ?? (d.startsWith('suscripción ') ? `Suscripción, plan ${d.slice(12)}` : humanize(d));

function StatementPanel({ initialMonth, compact = false }: { initialMonth: string; compact?: boolean }) {
  const [month, setMonth] = useState(initialMonth);
  const st = useApi<Statement>('/v1/account/usage', { month });
  const s = st.data;
  return (
    <section className="panel" aria-labelledby="stmt">
      <div className="panel-row">
        <h2 id="stmt">Estado de cuenta</h2>
        <label className="field" style={{ width: 170 }}>
          <span className="sr-only">Mes</span>
          <input type="month" value={month} max={limaToday().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
      </div>
      <ErrorNote error={st.error} />
      {st.loading && !s && <Loading />}
      {s && (
        <>
          <div className={`table-wrap${compact ? ' fit' : ''}`}>
            <table>
              <thead>
                <tr>
                  <th>Concepto</th>
                  {!compact && <th className="num">Cantidad</th>}
                  {!compact && <th className="num">Precio unitario</th>}
                  <th className="num">Importe</th>
                </tr>
              </thead>
              <tbody>
                {s.lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      {usageLabel(l.description)}
                      <span className="sub">
                        {MODULES[l.service] ?? l.service}
                        {compact && l.quantity !== 1 ? `, ${l.quantity} × ${fmtSoles(l.unitPrice)}` : ''}
                      </span>
                    </td>
                    {!compact && <td className="num">{l.quantity}</td>}
                    {!compact && <td className="num">{fmtSoles(l.unitPrice)}</td>}
                    <td className="num">{fmtSoles(l.amount)}</td>
                  </tr>
                ))}
                {!s.lines.length && (
                  <tr>
                    <td colSpan={compact ? 2 : 4} className="muted">
                      Sin consumo registrado en este mes.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={compact ? 1 : 3}>Subtotal</td>
                  <td className="num">{fmtSoles(s.subtotal)}</td>
                </tr>
                {s.bundleDiscount > 0 && (
                  <tr>
                    <td colSpan={compact ? 1 : 3}>Descuento por paquete ({Math.round(s.bundleDiscountRate * 100)} %)</td>
                    <td className="num">−{fmtSoles(s.bundleDiscount)}</td>
                  </tr>
                )}
                <tr>
                  <td colSpan={compact ? 1 : 3}>Total del mes, sin IGV</td>
                  <td className="num">{fmtSoles(s.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {s.passthroughUsd.length > 0 && (
            <p className="muted small" style={{ marginTop: 10 }}>
              Además, al costo:{' '}
              {s.passthroughUsd.map((p) => `${usageLabel(p.unit)} (${p.quantity}): ${fmtUsd(p.amount)}`).join('; ')}.
            </p>
          )}
          {compact && (
            <p style={{ marginTop: 12 }}>
              <a href="#/app/cuenta">Ver detalle y auditoría</a>
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- cuenta

const ACTIONS: Record<string, string> = {
  'document.received': 'Documento recibido',
  'document.analyzed': 'Documento analizado',
  'document.failed': 'Análisis fallido',
  'document.reviewed': 'Revisión de documento',
  'document.file_downloaded': 'Archivo descargado',
  'document_template.created': 'Plantilla creada',
  'document_template.deleted': 'Plantilla eliminada',
  'plaft_subject.screened': 'Sujeto revisado en listas',
  'plaft_subject.bulk_loaded': 'Carga masiva PLAFT',
  'plaft.portfolio_rescreened': 'Cartera revisada de nuevo',
  'plaft.monitored_billed': 'Registros monitoreados facturados',
  'regulatory.impact_status': 'Estado de impacto cambiado',
  'regulatory.impacts_computed': 'Impactos recalculados',
  'regulatory.task_created': 'Tarea creada',
  'regulatory.task_updated': 'Tarea actualizada',
  'regulatory.task_closed': 'Tarea cerrada',
  'regulatory.task_deleted': 'Tarea eliminada',
  'regulatory.comment_draft': 'Borrador de comentarios',
  'regulatory.processes_imported': 'Procesos importados',
  'regulatory.process_created': 'Proceso creado',
  'regulatory.process_updated': 'Proceso actualizado',
  'regulatory.process_deleted': 'Proceso eliminado',
  'claim.created': 'Siniestro registrado',
  'claim.photos_captured': 'Fotos capturadas en vivo',
  'claim.documents_complete': 'Documentación completa',
  'claim.cancelled': 'Siniestro cancelado',
  'claim.consented': 'Siniestro consentido',
  'claim.handoff': 'Derivado a un asesor',
  'claims.policies_imported': 'Pólizas importadas',
  'claims.config_updated': 'Configuración de siniestros',
};
const SUFFIX: Record<string, string> = {
  approve_to_adjuster: 'enviado al ajustador',
  request_info: 'pidió información',
  reject: 'rechazado',
  aprobado: 'aprobado',
  rechazado: 'rechazado',
  aclaracion: 'pidió aclaración',
  opened: 'abierto',
  decided: 'decidido',
};
const actionLabel = (a: string) => {
  if (ACTIONS[a]) return ACTIONS[a];
  const [prefix, rest] = a.startsWith('claim.review.')
    ? ['Revisión del analista', a.slice(13)]
    : a.startsWith('claim.decision.')
      ? ['Decisión del ajustador', a.slice(15)]
      : a.startsWith('plaft_case.')
        ? ['Caso PLAFT', a.slice(11)]
        : [null, a];
  return prefix ? `${prefix}: ${SUFFIX[rest] ?? rest.replace(/_/g, ' ')}` : a;
};

interface AuditRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entity_id: string | null;
  data: unknown;
  hash: string;
}

function AccountPage({ account }: { account: Account }) {
  const [entity, setEntity] = useState('');
  const [limit, setLimit] = useState(50);
  const audit = useApi<AuditRow[]>('/v1/account/audit', { entity: entity || undefined, limit });
  const verify = useAction();
  const [check, setCheck] = useState<{ ok: boolean; entries: number; brokenAt?: number } | null>(null);

  return (
    <>
      <PageHead title="Cuenta" sub="Contrato, consumo del mes y registro de auditoría." />
      <section className="panel">
        <h2>Su entidad</h2>
        <Facts
          items={[
            ['Nombre', account.name],
            ['Tipo de entidad', labelOf(ENTITY_TYPES, account.entityType)],
            ['Líneas de negocio', account.businessLines.join(', ') || '—'],
            [
              'Servicios activos',
              <span className="chips" key="m">
                {account.modules.map((m) => (
                  <Badge key={m} tone="ink">
                    {MODULES[m]}
                  </Badge>
                ))}
              </span>,
            ],
            ['Identificador', <span className="mono" key="id">{account.id}</span>],
            ['Usuario en esta sesión', session.user || 'Sin correo (se registra como llave de API)'],
          ]}
        />
      </section>
      <StatementPanel initialMonth={limaToday().slice(0, 7)} />
      <section className="panel" aria-labelledby="aud">
        <div className="panel-row">
          <h2 id="aud">Registro de auditoría</h2>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={verify.busy}
            onClick={() => verify.run(() => api('/v1/account/audit/verify')).then((r) => r && setCheck(r))}
          >
            {verify.busy ? 'Verificando…' : 'Verificar la cadena'}
          </button>
        </div>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Cada registro guarda la huella del anterior. Si alguien modifica o borra un registro, la verificación indica dónde se rompe.
        </p>
        <ErrorNote error={verify.error} />
        {check && (
          <p className={`note ${check.ok ? 'note-ok' : 'note-error'}`} role="status" style={{ marginBottom: 12 }}>
            {check.ok
              ? `La cadena está íntegra: ${check.entries} registros verificados.`
              : `La cadena se rompe en el registro ${check.brokenAt}. Revise ese registro y los posteriores (${check.entries} en total).`}
          </p>
        )}
        <div className="filters">
          <label className="field">
            <span className="field-label">Entidad</span>
            <select value={entity} onChange={(e) => setEntity(e.target.value)}>
              <option value="">Todas</option>
              <option value="document">Documentos</option>
              <option value="plaft_subject">Sujetos PLAFT</option>
              <option value="plaft_case">Casos PLAFT</option>
              <option value="plaft_portfolio">Cartera PLAFT</option>
              <option value="reg_impact">Impactos regulatorios</option>
              <option value="reg_task">Tareas regulatorias</option>
              <option value="reg_norm">Normas</option>
              <option value="reg_process">Procesos</option>
              <option value="claim">Siniestros</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Mostrar</span>
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              <option value={50}>Últimos 50</option>
              <option value={200}>Últimos 200</option>
              <option value={500}>Últimos 500</option>
            </select>
          </label>
        </div>
        <ErrorNote error={audit.error} />
        {audit.loading && !audit.data && <Loading />}
        {audit.data && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>N.°</th>
                  <th>Fecha</th>
                  <th>Acción</th>
                  <th>Quién</th>
                  <th>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.map((r) => (
                  <tr key={r.id}>
                    <td className="num">{r.id}</td>
                    <td className="nowrap">{fmtDateTime(r.at)}</td>
                    <td>
                      {actionLabel(r.action)}
                      <span className="sub">{r.action}</span>
                    </td>
                    <td>{r.actor}</td>
                    <td style={{ minWidth: 220 }}>
                      {r.data ? (
                        <details>
                          <summary>Ver datos</summary>
                          <pre className="json">{JSON.stringify(r.data, null, 2)}</pre>
                        </details>
                      ) : (
                        '—'
                      )}
                      <span className="sub mono" title="Huella de este registro">
                        {r.hash.slice(0, 16)}…
                      </span>
                    </td>
                  </tr>
                ))}
                {!audit.data.length && (
                  <tr>
                    <td colSpan={5} className="muted">
                      Sin registros para este filtro.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="muted small" style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Bear size={18} /> Ukuk significa oso de anteojos en quechua.
      </p>
    </>
  );
}
