import { useState, type FormEvent } from 'react';
import { api, session, type Page } from '../api';
import {
  Badge,
  Empty,
  ErrorNote,
  Facts,
  Loading,
  PageHead,
  Pager,
  Tabs,
  daysUntil,
  fmtDateTime,
  fmtDay,
  fmtPct,
  humanize,
  labelOf,
  limaToday,
  plural,
  useAction,
  useApi,
  type Tone,
} from '../ui';

const RELATIONS: Record<string, string> = {
  cliente: 'Cliente',
  proveedor: 'Proveedor',
  trabajador: 'Trabajador',
  director: 'Director',
  accionista: 'Accionista',
};
const KINDS: Record<string, string> = { individual: 'Persona natural', entity: 'Persona jurídica' };
const DOC_TYPES = ['DNI', 'CE', 'RUC', 'PASAPORTE'];
const REGIMES: Record<string, string> = { simplificado: 'Simplificado', general: 'General', reforzado: 'Reforzado' };
const regimeTone = (r: string): Tone => (r === 'reforzado' ? 'red' : r === 'simplificado' ? 'green' : 'muted');
const CATEGORIES: Record<string, string> = { pep: 'PEP', sanction: 'Sanción', interest: 'Lista de interés' };
const SOURCES: Record<string, string> = { pep_pe: 'PEP Perú', ofac_sdn: 'OFAC SDN', un: 'ONU', un_consolidated: 'ONU' };
const FACTORS: Record<string, string> = {
  coincidencia_pep: 'Coincidencia PEP',
  coincidencia_sancion: 'Coincidencia en sanciones',
  coincidencia_lista_interes: 'Lista de interés',
  pais_alto_riesgo: 'País de alto riesgo',
  noticias_negativas: 'Noticias negativas',
};
const DECISIONS: Record<string, string> = {
  falso_positivo: 'Falso positivo',
  coincidencia_confirmada: 'Coincidencia confirmada',
  escalado_uif: 'Escalado a la UIF',
};
const ORIGINS: Record<string, string> = { onboarding: 'Alta', bulk: 'Carga masiva', rescreen: 'Revisión de cartera' };
const sourceLabel = (s: string) => SOURCES[s] ?? s.toUpperCase().replace(/_/g, ' ');

export function Plaft({ parts }: { parts: string[] }) {
  const open = useApi<Page<unknown>>('/v1/plaft/cases', { status: 'abierto', limit: 1 });
  const tab = parts[0] === 'casos' ? '/app/plaft/casos' : parts[0] === 'reporte' ? '/app/plaft/reporte' : '/app/plaft';
  let body;
  if (parts[0] === 'casos' && parts[1]) body = <CaseDetail id={parts[1]} onDecided={open.reload} />;
  else if (parts[0] === 'casos') body = <Cases />;
  else if (parts[0] === 'reporte') body = <Report />;
  else if (parts[0] === 'sujetos' && parts[1]) body = <SubjectDetail id={parts[1]} />;
  else body = <Subjects onChanged={open.reload} />;
  return (
    <>
      <PageHead title="PLAFT" sub="Debida diligencia de clientes, proveedores, trabajadores y directores contra listas y PEP." />
      <Tabs
        current={tab}
        items={[
          { href: '/app/plaft', label: 'Sujetos' },
          { href: '/app/plaft/casos', label: 'Casos', count: open.data?.total },
          { href: '/app/plaft/reporte', label: 'Reporte' },
        ]}
      />
      {body}
    </>
  );
}

// ---------------------------------------------------------------- sujetos

interface Subject {
  id: string;
  relation: string;
  kind: string;
  name: string;
  doc_type: string;
  doc_number: string;
  birth_date: string | null;
  nationality: string | null;
  monitor: boolean;
  regime: string;
  risk_factors: string[];
  next_review_at: string | null;
  last_screened_at: string | null;
  open_cases?: number;
}

function Subjects({ onChanged }: { onChanged: () => void }) {
  const [panel, setPanel] = useState<'' | 'new' | 'bulk'>('');
  const [q, setQ] = useState('');
  const [relation, setRelation] = useState('');
  const [regime, setRegime] = useState('');
  const [monitor, setMonitor] = useState('');
  const [due, setDue] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const list = useApi<Page<Subject>>('/v1/plaft/subjects', {
    q: q.trim().length >= 1 ? q.trim() : undefined,
    relation: relation || undefined,
    regime: regime || undefined,
    monitor: monitor || undefined,
    due_within_days: due || undefined,
    limit,
    offset,
  });
  const rescreen = useAction();
  const [rescreenResult, setRescreenResult] = useState<any>(null);

  const changed = () => {
    list.reload();
    onChanged();
  };

  return (
    <>
      <div className="page-actions" style={{ marginBottom: 16 }}>
        <button type="button" className={`btn ${panel === 'new' ? 'btn-ghost' : 'btn-primary'}`} aria-expanded={panel === 'new'} onClick={() => setPanel(panel === 'new' ? '' : 'new')}>
          {panel === 'new' ? 'Cerrar' : 'Revisar a una persona o empresa'}
        </button>
        <button type="button" className="btn btn-quiet" aria-expanded={panel === 'bulk'} onClick={() => setPanel(panel === 'bulk' ? '' : 'bulk')}>
          Carga masiva (CSV)
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          disabled={rescreen.busy}
          onClick={() =>
            rescreen.run(() => api('/v1/plaft/rescreen', { method: 'POST' })).then((r) => {
              if (r) {
                setRescreenResult(r);
                changed();
              }
            })
          }
        >
          {rescreen.busy ? 'Revisando la cartera…' : 'Revisar cartera ahora'}
        </button>
      </div>
      <ErrorNote error={rescreen.error} />
      {rescreenResult && (
        <p className="note note-ok" role="status" style={{ marginBottom: 16 }}>
          Cartera revisada: {rescreenResult.subjects} sujetos monitoreados, {rescreenResult.with_matches} con coincidencias,{' '}
          {rescreenResult.new_matches} coincidencias nuevas y {rescreenResult.cases_opened} casos abiertos.
        </p>
      )}
      {panel === 'new' && <NewSubject onCreated={changed} />}
      {panel === 'bulk' && <BulkUpload onLoaded={changed} />}

      <section className="panel" aria-labelledby="subj-title" style={{ marginTop: panel ? 16 : 0 }}>
        <h2 id="subj-title">Cartera</h2>
        <div className="filters">
          <label className="field" style={{ flexBasis: 240 }}>
            <span className="field-label">Buscar</span>
            <input type="search" value={q} onChange={(e) => (setQ(e.target.value), setOffset(0))} placeholder="Nombre o documento" />
          </label>
          <label className="field">
            <span className="field-label">Relación</span>
            <select value={relation} onChange={(e) => (setRelation(e.target.value), setOffset(0))}>
              <option value="">Todas</option>
              {Object.entries(RELATIONS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Régimen</span>
            <select value={regime} onChange={(e) => (setRegime(e.target.value), setOffset(0))}>
              <option value="">Todos</option>
              {Object.entries(REGIMES).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Monitoreo</span>
            <select value={monitor} onChange={(e) => (setMonitor(e.target.value), setOffset(0))}>
              <option value="">Todos</option>
              <option value="true">Monitoreados</option>
              <option value="false">Sin monitoreo</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Próxima revisión</span>
            <select value={due} onChange={(e) => (setDue(e.target.value), setOffset(0))}>
              <option value="">Cualquier fecha</option>
              <option value="30">Vence en 30 días</option>
              <option value="90">Vence en 90 días</option>
            </select>
          </label>
        </div>
        <ErrorNote error={list.error} />
        {list.loading && !list.data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Relación</th>
                  <th>Régimen</th>
                  <th>Factores de riesgo</th>
                  <th>Próxima revisión</th>
                  <th className="num">Casos abiertos</th>
                </tr>
              </thead>
              <tbody>
                {list.data?.items.map((s) => {
                  const d = daysUntil(s.next_review_at);
                  return (
                    <tr key={s.id} className="row-link">
                      <td>
                        <a className="row-title" href={`#/app/plaft/sujetos/${s.id}`}>
                          {s.name}
                        </a>
                        <span className="sub">
                          {s.doc_type} {s.doc_number}
                          {!s.monitor && ', sin monitoreo'}
                        </span>
                      </td>
                      <td>{labelOf(RELATIONS, s.relation)}</td>
                      <td>
                        <Badge tone={regimeTone(s.regime)}>{labelOf(REGIMES, s.regime)}</Badge>
                      </td>
                      <td>{s.risk_factors.length ? s.risk_factors.map((f) => labelOf(FACTORS, f)).join(', ') : <span className="muted">Ninguno</span>}</td>
                      <td className="nowrap">
                        {fmtDay(s.next_review_at)}
                        {d !== null && d < 0 && (
                          <>
                            {' '}
                            <Badge tone="red">Vencida</Badge>
                          </>
                        )}
                      </td>
                      <td className="num">{s.open_cases ? <a href="#/app/plaft/casos">{s.open_cases}</a> : 0}</td>
                    </tr>
                  );
                })}
                {!list.data?.items.length && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No hay sujetos con estos filtros.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {list.data && <Pager total={list.data.total} limit={limit} offset={offset} onPage={setOffset} />}
      </section>
    </>
  );
}

function MatchesTable({ matches }: { matches: any[] }) {
  if (!matches.length) return <p className="muted">Sin coincidencias en las listas cargadas.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Nombre en la lista</th>
            <th>Lista</th>
            <th className="num">Similitud</th>
            <th>Por qué coincide</th>
          </tr>
        </thead>
        <tbody>
          {matches.map((m, i) => {
            const d = m.data ?? m;
            return (
              <tr key={m.id ?? i}>
                <td>
                  <strong>{m.matched_name ?? d.matched_name ?? d.name}</strong>
                  {d.programs?.length ? <span className="sub">Programa: {d.programs.join(', ')}</span> : null}
                  {d.birth_dates?.length ? <span className="sub">Nacimiento: {d.birth_dates.map(fmtDay).join(', ')}</span> : null}
                </td>
                <td>
                  <Badge tone={m.category === 'sanction' ? 'red' : m.category === 'pep' ? 'amber' : 'muted'}>{labelOf(CATEGORIES, m.category)}</Badge>
                  <span className="sub">
                    {sourceLabel(m.source)}
                    {m.entry_id ? `, ${m.entry_id}` : ''}
                  </span>
                </td>
                <td className="num">{fmtPct(m.score)}</td>
                <td>
                  {d.reasons?.length ? (
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {d.reasons.map((r: string) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  ) : (
                    '—'
                  )}
                  {m.status && m.status !== 'pendiente' && <span className="sub">Estado: {humanize(m.status)}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function NewSubject({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState({ relation: 'cliente', kind: 'individual', name: '', doc_type: 'DNI', doc_number: '', birth_date: '', nationality: 'PE', monitor: true });
  const act = useAction();
  const [result, setResult] = useState<any>(null);
  const set = (k: string, v: unknown) => setForm({ ...form, [k]: v });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {
      relation: form.relation,
      kind: form.kind,
      name: form.name.trim(),
      doc_type: form.doc_type,
      doc_number: form.doc_number.trim(),
      monitor: form.monitor,
    };
    if (form.kind === 'individual' && form.birth_date) body.birth_date = form.birth_date;
    if (form.nationality.trim()) body.nationality = form.nationality.trim();
    if (session.user) body.analyst = session.user;
    const r = await act.run(() => api('/v1/plaft/subjects', { body }));
    if (r) {
      setResult(r);
      onCreated();
    }
  };

  return (
    <section className="panel" aria-labelledby="new-subj">
      <h2 id="new-subj">Revisar a una persona o empresa</h2>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Relación con su entidad</span>
            <select value={form.relation} onChange={(e) => set('relation', e.target.value)}>
              {Object.entries(RELATIONS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Tipo</span>
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value, doc_type: e.target.value === 'entity' ? 'RUC' : 'DNI' })}
            >
              {Object.entries(KINDS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-wide">
            <span className="field-label">{form.kind === 'entity' ? 'Razón social' : 'Nombres y apellidos'}</span>
            <input value={form.name} onChange={(e) => set('name', e.target.value)} required minLength={2} maxLength={300} />
          </label>
          <label className="field">
            <span className="field-label">Tipo de documento</span>
            <select value={form.doc_type} onChange={(e) => set('doc_type', e.target.value)}>
              {DOC_TYPES.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Número de documento</span>
            <input
              value={form.doc_number}
              onChange={(e) => set('doc_number', e.target.value)}
              required
              maxLength={20}
              inputMode={form.doc_type === 'DNI' || form.doc_type === 'RUC' ? 'numeric' : undefined}
            />
          </label>
          {form.kind === 'individual' && (
            <label className="field">
              <span className="field-label">Fecha de nacimiento (opcional)</span>
              <input type="date" value={form.birth_date} onChange={(e) => set('birth_date', e.target.value)} max={limaToday()} />
            </label>
          )}
          <label className="field">
            <span className="field-label">Nacionalidad (opcional)</span>
            <input value={form.nationality} onChange={(e) => set('nationality', e.target.value.toUpperCase())} maxLength={3} placeholder="PE" />
            <span className="field-hint">Código de país de 2 o 3 letras.</span>
          </label>
          <label className="check field-wide">
            <input type="checkbox" checked={form.monitor} onChange={(e) => set('monitor', e.target.checked)} />
            Incluir en la revisión nocturna de la cartera
          </label>
        </div>
        <ErrorNote error={act.error} />
        <div>
          <button className="btn btn-primary" disabled={act.busy}>
            {act.busy ? 'Revisando en las listas…' : 'Revisar y registrar'}
          </button>
        </div>
      </form>
      {result && (
        <div style={{ marginTop: 20 }} role="status">
          <h3 className="h-small" style={{ marginTop: 0 }}>
            Resultado para {result.subject.name}
          </h3>
          <Facts
            items={[
              ['Régimen de debida diligencia', <Badge key="r" tone={regimeTone(result.subject.regime)}>{labelOf(REGIMES, result.subject.regime)}</Badge>],
              ['Factores de riesgo', result.subject.risk_factors.length ? result.subject.risk_factors.map((f: string) => labelOf(FACTORS, f)).join(', ') : 'Ninguno'],
              ['Próxima revisión', fmtDay(result.subject.next_review_at)],
              [
                'Noticias negativas',
                result.screening.adverse_media
                  ? result.screening.adverse_media.relevant
                    ? `${result.screening.adverse_media.relevant} sobre la misma persona, de ${result.screening.adverse_media.articles?.length ?? 0} revisadas`
                    : `Ninguna sobre esta persona (${result.screening.adverse_media.articles?.length ?? 0} revisadas)`
                  : '—',
              ],
            ]}
          />
          <div style={{ marginTop: 14 }}>
            <MatchesTable matches={result.screening.matches} />
          </div>
          {result.case_id && (
            <p className="note note-warn" style={{ marginTop: 12 }}>
              Se abrió un caso para que el oficial de cumplimiento decida. <a href={`#/app/plaft/casos/${result.case_id}`}>Abrir el caso</a>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function BulkUpload({ onLoaded }: { onLoaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [monitor, setMonitor] = useState(true);
  const act = useAction();
  const [result, setResult] = useState<any>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    form.append('monitor', String(monitor));
    if (session.user) form.append('analyst', session.user);
    const r = await act.run(() => api('/v1/plaft/subjects/bulk', { form }));
    if (r) {
      setResult(r);
      onLoaded();
    }
  };

  return (
    <section className="panel" aria-labelledby="bulk-title">
      <h2 id="bulk-title">Carga masiva</h2>
      <p className="muted small" style={{ marginBottom: 12 }}>
        Columnas obligatorias: name, kind (individual o entity), relation, doc_type, doc_number. Opcionales: birth_date (AAAA-MM-DD),
        nationality, monitor. Acepta coma o punto y coma como separador. Cada fila se revisa en las listas al cargarla.
      </p>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Archivo CSV</span>
            <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
          </label>
          <label className="check" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={monitor} onChange={(e) => setMonitor(e.target.checked)} />
            Monitorear las filas sin columna «monitor»
          </label>
        </div>
        <ErrorNote error={act.error} />
        <div>
          <button className="btn btn-primary" disabled={!file || act.busy}>
            {act.busy ? 'Cargando y revisando…' : 'Cargar y revisar'}
          </button>
        </div>
      </form>
      {result && (
        <div style={{ marginTop: 16 }} role="status">
          <p className={`note ${result.errors.length ? 'note-warn' : 'note-ok'}`}>
            {plural(result.received, 'fila recibida', 'filas recibidas')}: {result.created} {result.created === 1 ? 'nueva' : 'nuevas'},{' '}
            {result.updated} {result.updated === 1 ? 'actualizada' : 'actualizadas'}, {result.screened} revisadas en listas,{' '}
            {result.with_matches} con coincidencias y {plural(result.cases_opened, 'caso abierto', 'casos abiertos')}.
            {result.errors.length ? ` ${plural(result.errors.length, 'fila tiene', 'filas tienen')} errores.` : ''}
          </p>
          {result.errors.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr>
                    <th className="num">Línea</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {result.errors.map((er: any, i: number) => (
                    <tr key={i}>
                      <td className="num">{er.line}</td>
                      <td>{er.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SubjectDetail({ id }: { id: string }) {
  const s = useApi<any>(`/v1/plaft/subjects/${id}`);
  const d = s.data;
  return (
    <>
      <a className="crumb" href="#/app/plaft">
        Sujetos
      </a>
      <ErrorNote error={s.error} />
      {s.loading && !d && <Loading />}
      {d && (
        <div className="stack">
          <section className="panel">
            <h2>{d.name}</h2>
            <Facts
              items={[
                ['Relación', labelOf(RELATIONS, d.relation)],
                ['Tipo', labelOf(KINDS, d.kind)],
                ['Documento', `${d.doc_type} ${d.doc_number}`],
                ['Nacimiento', fmtDay(d.birth_date)],
                ['Nacionalidad', d.nationality ?? '—'],
                ['Régimen', <Badge key="r" tone={regimeTone(d.regime)}>{labelOf(REGIMES, d.regime)}</Badge>],
                ['Factores de riesgo', d.risk_factors.length ? d.risk_factors.map((f: string) => labelOf(FACTORS, f)).join(', ') : 'Ninguno'],
                ['Monitoreo nocturno', d.monitor ? 'Sí' : 'No'],
                ['Última revisión en listas', fmtDateTime(d.last_screened_at)],
                ['Próxima debida diligencia', fmtDay(d.next_review_at)],
              ]}
            />
          </section>
          <section className="panel">
            <h2>Coincidencias</h2>
            <MatchesTable matches={d.matches} />
          </section>
          <section className="panel">
            <h2>Casos</h2>
            {d.cases.length ? (
              <ul>
                {d.cases.map((c: any) => (
                  <li key={c.id}>
                    <a href={`#/app/plaft/casos/${c.id}`}>Caso del {fmtDay(c.created_at)}</a>: {c.status === 'abierto' ? 'abierto' : labelOf(DECISIONS, c.decision)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Sin casos.</p>
            )}
          </section>
          <section className="panel">
            <h2>Historial de revisiones</h2>
            <ol className="timeline">
              {d.screenings.map((sc: any) => (
                <li key={sc.id}>
                  <strong>{labelOf(ORIGINS, sc.kind)}</strong>: {plural(sc.matches.length, 'coincidencia', 'coincidencias')} (umbral {fmtPct(sc.threshold)})
                  <time dateTime={sc.created_at}>{fmtDateTime(sc.created_at)}</time>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- casos

function Cases() {
  const [status, setStatus] = useState('abierto');
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const list = useApi<Page<any>>('/v1/plaft/cases', { status: status || undefined, limit, offset });
  return (
    <section className="panel" aria-labelledby="cases-title">
      <div className="panel-row">
        <h2 id="cases-title">Casos</h2>
        <label className="field" style={{ width: 180 }}>
          <span className="sr-only">Estado</span>
          <select value={status} onChange={(e) => (setStatus(e.target.value), setOffset(0))}>
            <option value="abierto">Abiertos</option>
            <option value="cerrado">Cerrados</option>
            <option value="">Todos</option>
          </select>
        </label>
      </div>
      <ErrorNote error={list.error} />
      {list.loading && !list.data ? (
        <Loading />
      ) : list.data?.items.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Sujeto</th>
                <th>Relación</th>
                <th className="num">Coincidencias</th>
                <th className="num">Mayor similitud</th>
                <th>Origen</th>
                <th>Estado</th>
                <th>Abierto</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((c) => (
                <tr key={c.id} className="row-link">
                  <td>
                    <a className="row-title" href={`#/app/plaft/casos/${c.id}`}>
                      {c.subject_name}
                    </a>
                    <span className="sub">
                      {c.doc_type} {c.doc_number}
                    </span>
                  </td>
                  <td>{labelOf(RELATIONS, c.relation)}</td>
                  <td className="num">{c.matches}</td>
                  <td className="num">{c.top_score != null ? fmtPct(c.top_score) : '—'}</td>
                  <td>{labelOf(ORIGINS, c.origin)}</td>
                  <td>{c.status === 'abierto' ? <Badge tone="amber">Abierto</Badge> : <Badge tone="ink">{labelOf(DECISIONS, c.decision)}</Badge>}</td>
                  <td className="nowrap">{fmtDay(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{status === 'abierto' ? 'No hay casos abiertos. La cartera está al día.' : 'No hay casos con este filtro.'}</Empty>
      )}
      {list.data && <Pager total={list.data.total} limit={limit} offset={offset} onPage={setOffset} />}
    </section>
  );
}

function CaseDetail({ id, onDecided }: { id: string; onDecided: () => void }) {
  const c = useApi<any>(`/v1/plaft/cases/${id}`);
  const [decision, setDecision] = useState('');
  const [rationale, setRationale] = useState('');
  const act = useAction();
  const d = c.data;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { decision, rationale: rationale.trim() };
    if (session.user) body.analyst = session.user;
    const r = await act.run(() => api(`/v1/plaft/cases/${id}/decision`, { body }));
    if (r) {
      c.reload();
      onDecided();
    }
  };
  const len = rationale.trim().length;

  return (
    <>
      <a className="crumb" href="#/app/plaft/casos">
        Casos
      </a>
      <ErrorNote error={c.error} />
      {c.loading && !d && <Loading />}
      {d && (
        <div className="grid-doc">
          <div className="stack">
            <section className="panel">
              <div className="panel-row">
                <h2>{d.subject.name}</h2>
                {d.status === 'abierto' ? <Badge tone="amber">Abierto</Badge> : <Badge tone="ink">{labelOf(DECISIONS, d.decision)}</Badge>}
              </div>
              <Facts
                items={[
                  ['Relación', labelOf(RELATIONS, d.subject.relation)],
                  ['Documento', `${d.subject.doc_type} ${d.subject.doc_number}`],
                  ['Nacimiento', fmtDay(d.subject.birth_date)],
                  ['Nacionalidad', d.subject.nationality ?? '—'],
                  ['Régimen', <Badge key="r" tone={regimeTone(d.subject.regime)}>{labelOf(REGIMES, d.subject.regime)}</Badge>],
                  ['Origen del caso', labelOf(ORIGINS, d.origin)],
                ]}
              />
              <p style={{ marginTop: 12 }}>
                <a href={`#/app/plaft/sujetos/${d.subject.id}`}>Ver la ficha del sujeto</a>
              </p>
            </section>
            <section className="panel">
              <h2>Coincidencias</h2>
              <MatchesTable matches={d.matches} />
            </section>
          </div>
          <div className="stack">
            <section className="panel">
              <h2>Decisión</h2>
              {d.status === 'abierto' ? (
                <form className="form" onSubmit={submit}>
                  <fieldset className="field">
                    <legend className="sr-only">Decisión</legend>
                    <div className="radio-row">
                      {Object.entries(DECISIONS).map(([v, l]) => (
                        <label key={v}>
                          <input type="radio" name="decision" value={v} checked={decision === v} onChange={() => setDecision(v)} required />
                          {v === 'escalado_uif' ? 'Escalar a la UIF' : l}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <label className="field">
                    <span className="field-label">Sustento</span>
                    <textarea
                      rows={5}
                      value={rationale}
                      onChange={(e) => setRationale(e.target.value)}
                      minLength={20}
                      maxLength={8000}
                      required
                      aria-describedby="rat-hint"
                      placeholder="Por ejemplo: la fecha de nacimiento y el DNI no coinciden con la persona listada."
                    />
                    <span id="rat-hint" className="field-hint" aria-live="polite">
                      {len < 20 ? `Mínimo 20 caracteres; faltan ${20 - len}.` : 'Queda en el registro de auditoría para la supervisión.'}
                    </span>
                  </label>
                  <ErrorNote error={act.error} />
                  <div>
                    <button className="btn btn-primary" disabled={!decision || len < 20 || act.busy}>
                      {act.busy ? 'Guardando…' : 'Registrar decisión'}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <Facts
                    items={[
                      ['Decisión', labelOf(DECISIONS, d.decision)],
                      ['Por', d.decided_by?.replace(/^analyst:/, '') ?? '—'],
                      ['Fecha', fmtDateTime(d.decided_at)],
                    ]}
                  />
                  <p style={{ marginTop: 12 }}>{d.rationale}</p>
                  {d.ros_draft && (
                    <p className="note note-warn" style={{ marginTop: 12 }}>
                      Marcado para preparar el reporte de operación sospechosa (ROS) a la UIF.
                    </p>
                  )}
                </>
              )}
            </section>
            <section className="panel">
              <h2>Historial</h2>
              <ol className="timeline">
                {d.timeline.map((ev: any) => (
                  <li key={ev.id}>
                    <strong>{ev.type === 'opened' ? 'Caso abierto' : ev.type === 'decided' ? `Decisión: ${labelOf(DECISIONS, ev.data?.decision)}` : humanize(ev.type)}</strong>
                    {ev.type === 'opened' && ev.data?.matches && <span className="muted">: {plural(ev.data.matches.length, 'coincidencia', 'coincidencias')}</span>}
                    {ev.type === 'decided' && ev.data?.subject_regime && <span className="muted">. Régimen: {labelOf(REGIMES, ev.data.subject_regime)}</span>}
                    <time dateTime={ev.at}>
                      {fmtDateTime(ev.at)}, {ev.actor.replace(/^analyst:/, '')}
                    </time>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- reporte

function Counts({ data, labels }: { data: Record<string, number>; labels?: Record<string, string> }) {
  const entries = Object.entries(data ?? {});
  if (!entries.length) return <span className="muted">Ninguno</span>;
  return <>{entries.map(([k, v]) => `${labels ? labelOf(labels, k) : humanize(k)}: ${v}`).join('; ')}</>;
}

function Report() {
  const today = limaToday();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const r = useApi<any>('/v1/plaft/report', { from, to: `${to}T23:59:59.999-05:00` });
  const d = r.data;
  return (
    <>
      <div className="filters">
        <label className="field">
          <span className="field-label">Desde</span>
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Hasta</span>
          <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
      </div>
      <ErrorNote error={r.error} />
      {r.loading && !d && <Loading />}
      {d && (
        <div className="stack">
          <div className="grid-2">
            <section className="panel">
              <h2>Cartera</h2>
              <Facts
                items={[
                  ['Sujetos registrados', d.portfolio.total],
                  ['Monitoreados', d.portfolio.monitored],
                  ['Por relación', <Counts key="a" data={d.portfolio.by_relation} labels={RELATIONS} />],
                  ['Por régimen', <Counts key="b" data={d.portfolio.by_regime} labels={REGIMES} />],
                  ['Casos abiertos hoy', d.open_cases],
                ]}
              />
            </section>
            <section className="panel">
              <h2>
                Del {fmtDay(from)} al {fmtDay(to)}
              </h2>
              <Facts
                items={[
                  ['Altas por relación', <Counts key="a" data={d.period.new_subjects_by_relation} labels={RELATIONS} />],
                  ['Revisiones en listas', <Counts key="b" data={d.period.screenings_by_kind} labels={ORIGINS} />],
                  ['Coincidencias', <Counts key="c" data={d.period.matches_by_category} labels={CATEGORIES} />],
                  ['Casos abiertos', d.period.cases_opened],
                  ['Decisiones', <Counts key="d" data={d.period.decisions} labels={DECISIONS} />],
                  ['Marcados para ROS', d.period.ros_drafts],
                ]}
              />
            </section>
          </div>
          <section className="panel">
            <h2>Debida diligencia por vencer en 30 días</h2>
            <p className="muted small" style={{ marginBottom: 12 }}>
              {d.reviews_due_30_days.count} sujetos, {d.reviews_due_30_days.overdue} ya vencidos. Los proveedores se actualizan al menos cada 2 años
              (Res. SBS 01015-2026).
            </p>
            {d.reviews_due_30_days.subjects.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Nombre</th>
                      <th>Relación</th>
                      <th>Régimen</th>
                      <th>Vence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.reviews_due_30_days.subjects.map((s: any) => (
                      <tr key={s.id}>
                        <td>
                          <a href={`#/app/plaft/sujetos/${s.id}`}>{s.name}</a>
                        </td>
                        <td>{labelOf(RELATIONS, s.relation)}</td>
                        <td>{labelOf(REGIMES, s.regime)}</td>
                        <td className="nowrap">{fmtDay(s.next_review_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>Nadie vence en los próximos 30 días.</Empty>
            )}
          </section>
        </div>
      )}
    </>
  );
}
