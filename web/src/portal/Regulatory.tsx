import { useMemo, useState, type FormEvent } from 'react';
import { api, download } from '../api';
import {
  Badge,
  Empty,
  ErrorNote,
  Facts,
  Loading,
  PageHead,
  Tabs,
  daysUntil,
  fmtDay,
  fmtPct,
  labelOf,
  limaToday,
  plural,
  useAction,
  useApi,
  type Tone,
} from '../ui';

const TOPICS: Record<string, string> = {
  plaft: 'PLAFT',
  seguros: 'Seguros',
  siniestros: 'Siniestros',
  datos_personales: 'Datos personales',
  seguridad_informacion: 'Seguridad de la información',
  riesgo_operacional: 'Riesgo operacional',
  conducta_mercado: 'Conducta de mercado',
  gobierno_corporativo: 'Gobierno corporativo',
  credito: 'Crédito',
  tributario: 'Tributario',
  pensiones: 'Pensiones',
};
const SOURCES: Record<string, string> = {
  el_peruano: 'El Peruano',
  sbs: 'SBS',
  smv: 'SMV',
  bcrp: 'BCRP',
  uif: 'UIF',
  susalud: 'SUSALUD',
  indecopi: 'INDECOPI',
};
const IMPACT_STATUS: Record<string, string> = {
  pendiente: 'Pendiente',
  en_adecuacion: 'En adecuación',
  adecuado: 'Adecuado',
  no_aplica: 'No aplica',
};
const impactTone = (s: string): Tone => (s === 'pendiente' ? 'amber' : s === 'en_adecuacion' ? 'blue' : s === 'adecuado' ? 'green' : 'muted');
const TASK_STATUS: Record<string, string> = { abierta: 'Abierta', en_progreso: 'En progreso', cerrada: 'Cerrada' };
const KINDS: Record<string, string> = { politica: 'Política', proceso: 'Proceso', manual: 'Manual', procedimiento: 'Procedimiento' };

export function Regulatory({ parts }: { parts: string[] }) {
  const map: Record<string, string> = { normas: '/app/radar/normas', matriz: '/app/radar/matriz', procesos: '/app/radar/procesos', tareas: '/app/radar/tareas' };
  const tab = map[parts[0]] ?? '/app/radar';
  let body;
  if (parts[0] === 'normas' && parts[1]) body = <NormDetail id={parts[1]} />;
  else if (parts[0] === 'normas') body = <Norms />;
  else if (parts[0] === 'matriz') body = <Matrix />;
  else if (parts[0] === 'procesos') body = <Processes />;
  else if (parts[0] === 'tareas') body = <Tasks />;
  else body = <Digest />;
  return (
    <>
      <PageHead title="Radar regulatorio" sub="Normas nuevas conectadas a sus políticas, procesos y manuales." />
      <Tabs
        current={tab}
        items={[
          { href: '/app/radar', label: 'Resumen diario' },
          { href: '/app/radar/normas', label: 'Normas' },
          { href: '/app/radar/matriz', label: 'Matriz de impacto' },
          { href: '/app/radar/procesos', label: 'Procesos' },
          { href: '/app/radar/tareas', label: 'Tareas' },
        ]}
      />
      {body}
    </>
  );
}

function Topics({ list }: { list: string[] }) {
  if (!list?.length) return <span className="muted">—</span>;
  return <>{list.map((t) => labelOf(TOPICS, t)).join(', ')}</>;
}

function ImpactLine({ i }: { i: any }) {
  return (
    <li>
      <strong>{i.process_code}</strong> {i.process_name}{' '}
      <span className="muted">
        (afinidad {fmtPct(i.score)}
        {i.articles?.length ? `, art. ${i.articles.join(', ')}` : ''})
      </span>{' '}
      <Badge tone={impactTone(i.status)}>{labelOf(IMPACT_STATUS, i.status)}</Badge>
    </li>
  );
}

// ---------------------------------------------------------------- resumen diario

function Digest() {
  const [date, setDate] = useState(limaToday());
  const d = useApi<any>('/v1/regulatory/digest', { date });
  const data = d.data;
  const nothing = data && !data.new_norms.length && !data.consultations.length && !data.upcoming_effective.length;
  return (
    <>
      <div className="filters">
        <label className="field">
          <span className="field-label">Día</span>
          <input type="date" value={date} max={limaToday()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
      </div>
      <ErrorNote error={d.error} />
      {d.loading && !data && <Loading />}
      {data && (
        <div className="stack">
          {data.overdue_tasks > 0 && (
            <p className="note note-error">
              Hay {data.overdue_tasks} tareas de adecuación vencidas. <a href="#/app/radar/tareas">Ver tareas</a>
            </p>
          )}
          {nothing && (
            <Empty>
              El {fmtDay(date)} no se publicaron normas relevantes para su entidad. <a href="#/app/radar/normas">Ver todas las normas</a>
            </Empty>
          )}
          {data.new_norms.length > 0 && (
            <section className="panel">
              <h2>Normas publicadas el {fmtDay(date)}</h2>
              {data.new_norms.map((n: any) => (
                <NormCard key={n.id} n={n} />
              ))}
            </section>
          )}
          {data.consultations.length > 0 && (
            <section className="panel">
              <h2>Proyectos abiertos a comentarios</h2>
              {data.consultations.map((n: any) => (
                <NormCard key={n.id} n={n} consultation />
              ))}
            </section>
          )}
          {data.upcoming_effective.length > 0 && (
            <section className="panel">
              <h2>Entran en vigencia hasta el {fmtDay(data.window_end)}</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Norma</th>
                      <th>Proceso</th>
                      <th>Vigencia</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.upcoming_effective.map((u: any) => (
                      <tr key={u.id}>
                        <td>
                          {u.norm_number}
                          <span className="sub">{u.norm_title}</span>
                        </td>
                        <td>{u.process_code}</td>
                        <td className="nowrap">{fmtDay(u.effective_at)}</td>
                        <td>
                          <Badge tone={impactTone(u.status)}>{labelOf(IMPACT_STATUS, u.status)}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </>
  );
}

function NormCard({ n, consultation }: { n: any; consultation?: boolean }) {
  return (
    <article className="norm-card" style={{ padding: '14px 0', borderTop: '1px solid var(--line)' }}>
      <p className="muted small">
        {labelOf(SOURCES, n.source)}, {n.number ?? 'sin número'}. Publicada el {fmtDay(n.published_at)}
        {n.effective_at ? `; vigente desde el ${fmtDay(n.effective_at)}` : ''}.
      </p>
      <h3 style={{ fontSize: 17, margin: '4px 0 6px' }}>
        <a href={`#/app/radar/normas/${n.id}`}>{n.title}</a>
      </h3>
      {n.summary && <p style={{ maxWidth: '80ch' }}>{n.summary}</p>}
      {consultation && (
        <p style={{ marginTop: 8 }}>
          Comentarios hasta el <strong>{fmtDay(n.comments_deadline)}</strong>{' '}
          {n.days_left !== null && <Badge tone={n.days_left <= 7 ? 'red' : 'amber'}>{n.days_left} días</Badge>}{' '}
          <a href={`#/app/radar/normas/${n.id}`}>Preparar comentarios</a>
        </p>
      )}
      {n.impacts?.length ? (
        <ul style={{ margin: '10px 0 0', paddingLeft: 18, display: 'grid', gap: 4 }}>
          {n.impacts.map((i: any) => (
            <ImpactLine key={i.id} i={i} />
          ))}
        </ul>
      ) : (
        <p className="muted small" style={{ marginTop: 8 }}>
          No toca ningún proceso de su inventario.
        </p>
      )}
    </article>
  );
}

// ---------------------------------------------------------------- normas

function Norms() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [scope, setScope] = useState('general');
  const [topic, setTopic] = useState('');
  const [source, setSource] = useState('');
  const list = useApi<any[]>('/v1/regulatory/norms', {
    q: q.trim() || undefined,
    status: status || undefined,
    scope: scope || undefined,
    topic: topic || undefined,
    source: source || undefined,
    limit: 200,
  });
  return (
    <section className="panel">
      <div className="filters">
        <label className="field" style={{ flexBasis: 260 }}>
          <span className="field-label">Buscar</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Título, número o texto" />
        </label>
        <label className="field">
          <span className="field-label">Estado</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option>
            <option value="vigente">Vigentes</option>
            <option value="proyecto">Proyectos</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Alcance</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="general">Carácter general</option>
            <option value="particular">Particulares</option>
            <option value="">Todas</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Tema</span>
          <select value={topic} onChange={(e) => setTopic(e.target.value)}>
            <option value="">Todos</option>
            {Object.entries(TOPICS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Fuente</span>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Todas</option>
            {Object.entries(SOURCES).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
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
                <th>Norma</th>
                <th>Fuente</th>
                <th>Publicada</th>
                <th>Vigencia</th>
                <th>Temas</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.map((n) => (
                <tr key={n.id} className="row-link">
                  <td style={{ minWidth: 280 }}>
                    <a className="row-title" href={`#/app/radar/normas/${n.id}`}>
                      {n.title}
                    </a>
                    <span className="sub">
                      {n.number}
                      {n.status === 'proyecto' && ', proyecto'}
                      {n.scope === 'particular' && ', particular'}
                    </span>
                  </td>
                  <td>{labelOf(SOURCES, n.source)}</td>
                  <td className="nowrap">{fmtDay(n.published_at)}</td>
                  <td className="nowrap">{n.status === 'proyecto' ? `Comentarios hasta ${fmtDay(n.comments_deadline)}` : fmtDay(n.effective_at)}</td>
                  <td>
                    <Topics list={n.topics} />
                  </td>
                </tr>
              ))}
              {!list.data?.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    No hay normas con estos filtros.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ImpactStatus({ id, status, onChanged }: { id: string; status: string; onChanged: () => void }) {
  const act = useAction();
  return (
    <span style={{ display: 'inline-grid', gap: 4 }}>
      <select
        aria-label="Estado del impacto"
        value={status}
        disabled={act.busy}
        onChange={(e) => act.run(() => api(`/v1/regulatory/impacts/${id}`, { method: 'PATCH', body: { status: e.target.value } })).then((r) => r && onChanged())}
        style={{ padding: '5px 8px', fontSize: 14, minWidth: 150 }}
      >
        {Object.entries(IMPACT_STATUS).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {act.error && <span className="small" style={{ color: 'var(--red)' }}>{act.error.message}</span>}
    </span>
  );
}

function NormDetail({ id }: { id: string }) {
  const n = useApi<any>(`/v1/regulatory/norms/${id}`);
  const draft = useAction();
  const [text, setText] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const d = n.data;
  return (
    <>
      <a className="crumb" href="#/app/radar/normas">
        Normas
      </a>
      <ErrorNote error={n.error} />
      {n.loading && !d && <Loading />}
      {d && (
        <div className="grid-doc">
          <div className="stack">
            <section className="panel">
              <p className="muted small">
                {labelOf(SOURCES, d.source)}, {d.issuer ?? 'emisor no indicado'}
              </p>
              <h2 style={{ fontSize: 20, margin: '4px 0 10px' }}>{d.title}</h2>
              <Facts
                items={[
                  ['Número', d.number ?? '—'],
                  ['Estado', d.status === 'proyecto' ? 'Proyecto de norma' : 'Vigente'],
                  ['Alcance', d.scope === 'general' ? 'Carácter general' : 'Particular'],
                  ['Publicada', fmtDay(d.published_at)],
                  [d.status === 'proyecto' ? 'Comentarios hasta' : 'Vigencia', fmtDay(d.status === 'proyecto' ? d.comments_deadline : d.effective_at)],
                  ['Temas', <Topics key="t" list={d.topics} />],
                ]}
              />
              {d.classification?.scope_reason && (
                <p className="muted small" style={{ marginTop: 10 }}>
                  Clasificación ({d.classification.method}): {d.classification.scope_reason}.
                </p>
              )}
              {(d.url || d.pdf_url) && (
                <p style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {d.url && (
                    <a href={d.url} target="_blank" rel="noopener noreferrer">
                      Ver en la fuente oficial
                    </a>
                  )}
                  {d.pdf_url && (
                    <a href={d.pdf_url} target="_blank" rel="noopener noreferrer">
                      Abrir el PDF oficial
                    </a>
                  )}
                </p>
              )}
            </section>
            {d.classification?.obligations?.length > 0 && (
              <section className="panel">
                <h2>Obligaciones que crea</h2>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 8 }}>
                  {d.classification.obligations.map((o: any, i: number) => (
                    <li key={i}>
                      <strong>Art. {o.article}.</strong> {o.obligation}
                      {o.deadline && <span className="sub">Plazo: {o.deadline}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="panel">
              <h2>Articulado</h2>
              {d.articles?.length ? (
                <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}>
                  {d.articles.map((a: any) => (
                    <li key={a.number}>
                      <strong>Artículo {a.number}</strong>
                      <p style={{ whiteSpace: 'pre-wrap', maxWidth: '80ch' }}>{a.text}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p style={{ whiteSpace: 'pre-wrap', maxWidth: '80ch' }}>{d.text || d.summary || 'Sin texto disponible.'}</p>
              )}
            </section>
          </div>
          <div className="stack">
            <section className="panel">
              <h2>Impacto en sus procesos</h2>
              {d.impacts.length ? (
                <div style={{ display: 'grid', gap: 14 }}>
                  {d.impacts.map((i: any) => (
                    <article key={i.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
                      <div className="panel-row" style={{ marginBottom: 6 }}>
                        <strong>
                          {i.process_code} {i.process_name}
                        </strong>
                        <ImpactStatus id={i.id} status={i.status} onChanged={n.reload} />
                      </div>
                      <p className="muted small">
                        {labelOf(KINDS, i.process_kind)}, responsable {i.owner_email ?? 'sin asignar'}, afinidad {fmtPct(i.score)}.
                      </p>
                      <p className="small" style={{ marginTop: 6 }}>
                        {i.rationale}
                      </p>
                      <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                        {i.matched_articles.map((a: any) => (
                          <li key={a.number}>
                            Art. {a.number}
                            {a.keywords?.length ? ` (${a.keywords.join(', ')})` : ''}: {a.excerpt}
                          </li>
                        ))}
                      </ul>
                      <p style={{ marginTop: 8 }}>
                        <a href={`#/app/radar/tareas?impacto=${i.id}`}>Crear una tarea de adecuación</a>
                      </p>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="muted">Esta norma no toca ningún proceso de su inventario.</p>
              )}
            </section>
            {d.status === 'proyecto' && (
              <section className="panel">
                <h2>Comentarios a la SBS</h2>
                <p className="muted small" style={{ marginBottom: 12 }}>
                  Un borrador por artículo, con los procesos afectados. Complete los corchetes antes de enviarlo.
                </p>
                <ErrorNote error={draft.error} />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={draft.busy}
                  onClick={() => draft.run(() => api(`/v1/regulatory/norms/${id}/comment-draft`, { method: 'POST' })).then((r) => r && setText(r))}
                >
                  {draft.busy ? 'Redactando…' : text ? 'Redactar de nuevo' : 'Redactar borrador'}
                </button>
                {text && (
                  <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
                    <div className="draft">
                      <DraftText text={text.draft} />
                    </div>
                    <div className="page-actions">
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        onClick={() => navigator.clipboard?.writeText(text.draft).then(() => setCopied(true))}
                      >
                        {copied ? 'Copiado' : 'Copiar el texto'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        onClick={() => {
                          const url = URL.createObjectURL(new Blob([text.draft], { type: 'text/markdown' }));
                          Object.assign(document.createElement('a'), { href: url, download: 'comentarios-proyecto.md' }).click();
                          setTimeout(() => URL.revokeObjectURL(url), 2000);
                        }}
                      >
                        Descargar (.md)
                      </button>
                    </div>
                    <p className="muted small">Redactado con {text.method === 'llm' ? 'el modelo de lenguaje' : 'la plantilla'}.</p>
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** Markdown mínimo del borrador: títulos, citas y párrafos. */
function DraftText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((l, i) => {
        if (l.startsWith('### ')) return <h5 key={i}>{l.slice(4)}</h5>;
        if (l.startsWith('## ')) return <h4 key={i}>{l.slice(3)}</h4>;
        if (l.startsWith('# ')) return <h3 key={i}>{l.slice(2)}</h3>;
        if (l.startsWith('> ')) return <blockquote key={i}>{l.slice(2)}</blockquote>;
        return l.trim() ? <p key={i}>{l}</p> : null;
      })}
    </>
  );
}

// ---------------------------------------------------------------- matriz

interface MatrixRow {
  impact_id: string;
  norm_id: string;
  norm_number: string;
  norm_title: string;
  effective_at: string | null;
  process_code: string;
  process_name: string;
  owner_email: string | null;
  score: number;
  status: string;
  open_tasks: number;
  article: string;
  article_excerpt: string;
}

function groupImpacts(rows: MatrixRow[]) {
  const out: (MatrixRow & { articles: { n: string; t: string }[] })[] = [];
  for (const r of rows) {
    const g = out.find((x) => x.impact_id === r.impact_id);
    if (g) g.articles.push({ n: r.article, t: r.article_excerpt });
    else out.push({ ...r, articles: r.article ? [{ n: r.article, t: r.article_excerpt }] : [] });
  }
  return out;
}

function Matrix() {
  const [status, setStatus] = useState('');
  const [proc, setProc] = useState('');
  const processes = useApi<any[]>('/v1/regulatory/processes');
  const q = { status: status || undefined, process_code: proc || undefined };
  const m = useApi<MatrixRow[]>('/v1/regulatory/impact-matrix', q);
  const rows = useMemo(() => groupImpacts(m.data ?? []), [m.data]);
  const dl = useAction();
  return (
    <section className="panel">
      <div className="filters">
        <label className="field">
          <span className="field-label">Estado</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option>
            {Object.entries(IMPACT_STATUS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flexBasis: 260 }}>
          <span className="field-label">Proceso</span>
          <select value={proc} onChange={(e) => setProc(e.target.value)}>
            <option value="">Todos</option>
            {processes.data?.map((p) => (
              <option key={p.id} value={p.code}>
                {p.code} {p.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-quiet"
          disabled={dl.busy}
          onClick={() => dl.run(() => download('/v1/regulatory/impact-matrix', 'matriz-impacto.csv', { ...q, format: 'csv' }))}
        >
          {dl.busy ? 'Preparando…' : 'Descargar CSV'}
        </button>
      </div>
      <ErrorNote error={m.error ?? dl.error} />
      {m.loading && !m.data ? (
        <Loading />
      ) : rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Norma</th>
                <th>Artículos</th>
                <th>Proceso afectado</th>
                <th className="num">Afinidad</th>
                <th>Vigencia</th>
                <th>Estado</th>
                <th>Tareas</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const days = daysUntil(r.effective_at);
                return (
                  <tr key={r.impact_id}>
                    <td style={{ minWidth: 220 }}>
                      <a className="row-title" href={`#/app/radar/normas/${r.norm_id}`}>
                        {r.norm_number}
                      </a>
                      <span className="sub">{r.norm_title}</span>
                    </td>
                    <td style={{ minWidth: 260 }}>
                      {r.articles.map((a) => (
                        <span key={a.n} className="sub" style={{ color: 'var(--ink)' }}>
                          <strong>Art. {a.n}.</strong> {a.t.length > 140 ? a.t.slice(0, 140) + '…' : a.t}
                        </span>
                      ))}
                    </td>
                    <td>
                      <strong>{r.process_code}</strong> {r.process_name}
                      <span className="sub">{r.owner_email}</span>
                    </td>
                    <td className="num">{fmtPct(r.score)}</td>
                    <td className="nowrap">
                      {fmtDay(r.effective_at)}
                      {days !== null && days >= 0 && days <= 30 && r.status !== 'adecuado' && r.status !== 'no_aplica' && (
                        <span className="sub">
                          <Badge tone="red">en {days} días</Badge>
                        </span>
                      )}
                    </td>
                    <td>
                      <ImpactStatus id={r.impact_id} status={r.status} onChanged={m.reload} />
                    </td>
                    <td className="nowrap">
                      {r.open_tasks ? `${r.open_tasks} abiertas` : <span className="muted">Ninguna</span>}
                      <span className="sub">
                        <a href={`#/app/radar/tareas?impacto=${r.impact_id}`}>Nueva tarea</a>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No hay impactos con estos filtros.</Empty>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- procesos

const SAMPLE_CSV = 'code,name,kind,description,owner_email,topics,keywords\nPR-REE-01,Reembolsos de salud,proceso,Revisión de boletas y recetas,reembolsos@entidad.pe,seguros|siniestros,reembolso|boleta';

function Processes() {
  const list = useApi<any[]>('/v1/regulatory/processes');
  const [csv, setCsv] = useState('');
  const [open, setOpen] = useState(false);
  const act = useAction();
  const [result, setResult] = useState<any>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => api('/v1/regulatory/processes/import', { body: { csv } }));
    if (r) {
      setResult(r);
      list.reload();
    }
  };

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-row">
          <h2>Inventario de políticas y procesos</h2>
          <button type="button" className="btn btn-quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Cerrar importación' : 'Importar CSV'}
          </button>
        </div>
        {open && (
          <form className="form" onSubmit={submit} style={{ marginBottom: 18 }}>
            <p className="muted small">
              Columnas: code, name, kind (politica, proceso, manual o procedimiento), description, owner_email, topics y keywords. En topics y
              keywords separe los valores con «|». Si el código ya existe, se actualiza. Al importar se recalcula la matriz de impacto.
            </p>
            <label className="field">
              <span className="field-label">Archivo</span>
              <input type="file" accept=".csv,text/csv" onChange={async (e) => setCsv((await e.target.files?.[0]?.text()) ?? csv)} />
            </label>
            <label className="field">
              <span className="field-label">Contenido CSV</span>
              <textarea rows={6} className="mono" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={SAMPLE_CSV} spellCheck={false} />
            </label>
            <ErrorNote error={act.error} />
            <div>
              <button className="btn btn-primary" disabled={!csv.trim() || act.busy}>
                {act.busy ? 'Importando…' : 'Importar procesos'}
              </button>
            </div>
            {result && (
              <div role="status">
                <p className={`note ${result.errors?.length ? 'note-warn' : 'note-ok'}`}>
                  {result.imported} procesos importados ({result.created} nuevos, {result.updated} actualizados). Se recalcularon{' '}
                  {result.impacts} impactos.
                  {result.errors?.length ? ` ${plural(result.errors.length, 'fila tiene', 'filas tienen')} errores:` : ''}
                </p>
                {result.errors?.length > 0 && (
                  <ul className="small">
                    {result.errors.map((er: any, i: number) => (
                      <li key={i}>{typeof er === 'string' ? er : `Línea ${er.line}: ${er.error ?? er.message}`}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </form>
        )}
        <ErrorNote error={list.error} />
        {list.loading && !list.data ? (
          <Loading />
        ) : list.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Nombre</th>
                  <th>Tipo</th>
                  <th>Responsable</th>
                  <th>Temas</th>
                  <th>Palabras clave</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((p) => (
                  <tr key={p.id}>
                    <td className="nowrap">
                      <strong>{p.code}</strong>
                    </td>
                    <td>
                      {p.name}
                      {p.description && <span className="sub">{p.description}</span>}
                    </td>
                    <td>{labelOf(KINDS, p.kind)}</td>
                    <td>{p.owner_email ?? '—'}</td>
                    <td>
                      <Topics list={p.topics} />
                    </td>
                    <td>{p.keywords?.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Todavía no cargó su inventario. Impórtelo en CSV para que el radar conecte cada norma con sus procesos.</Empty>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- tareas

function Tasks() {
  const preset = /[?&]impacto=([\w-]+)/.exec(window.location.hash)?.[1] ?? '';
  const [status, setStatus] = useState('');
  const [overdue, setOverdue] = useState(false);
  const list = useApi<any[]>('/v1/regulatory/tasks', { status: status || undefined, overdue: overdue ? 'true' : undefined });
  const matrix = useApi<MatrixRow[]>('/v1/regulatory/impact-matrix');
  const impacts = useMemo(() => groupImpacts(matrix.data ?? []), [matrix.data]);
  const [form, setForm] = useState({ impact_id: preset, title: '', responsible_email: '', due_at: '' });
  const [open, setOpen] = useState(!!preset);
  const create = useAction();
  const [closing, setClosing] = useState<string | null>(null);
  const [evidence, setEvidence] = useState('');
  const update = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await create.run(() => api('/v1/regulatory/tasks', { body: form }));
    if (r) {
      setForm({ impact_id: '', title: '', responsible_email: '', due_at: '' });
      setOpen(false);
      list.reload();
    }
  };
  const patch = async (id: string, body: Record<string, unknown>) => {
    const r = await update.run(() => api(`/v1/regulatory/tasks/${id}`, { method: 'PATCH', body }));
    if (r) {
      setClosing(null);
      setEvidence('');
      list.reload();
    }
  };

  const chosen = impacts.find((i) => i.impact_id === form.impact_id);

  return (
    <div className="stack">
      <div className="page-actions">
        <button type="button" className={`btn ${open ? 'btn-ghost' : 'btn-primary'}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Cerrar' : 'Nueva tarea'}
        </button>
      </div>
      {open && (
        <section className="panel">
          <h2>Nueva tarea de adecuación</h2>
          <form className="form" onSubmit={submit}>
            <div className="form-grid">
              <label className="field field-wide">
                <span className="field-label">Impacto</span>
                <select value={form.impact_id} onChange={(e) => setForm({ ...form, impact_id: e.target.value })} required>
                  <option value="">Elegir norma y proceso</option>
                  {impacts.map((i) => (
                    <option key={i.impact_id} value={i.impact_id}>
                      {i.norm_number}: {i.process_code} {i.process_name}
                    </option>
                  ))}
                </select>
                {chosen && <span className="field-hint">{chosen.norm_title}</span>}
              </label>
              <label className="field field-wide">
                <span className="field-label">Qué hay que hacer</span>
                <input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  required
                  minLength={3}
                  maxLength={500}
                  placeholder="Actualizar el manual de siniestros con el canal de WhatsApp"
                />
              </label>
              <label className="field">
                <span className="field-label">Responsable (correo)</span>
                <input
                  type="email"
                  value={form.responsible_email}
                  onChange={(e) => setForm({ ...form, responsible_email: e.target.value })}
                  required
                  placeholder={chosen?.owner_email ?? 'responsable@entidad.pe'}
                />
              </label>
              <label className="field">
                <span className="field-label">Vence el</span>
                <input type="date" value={form.due_at} min={limaToday()} onChange={(e) => setForm({ ...form, due_at: e.target.value })} required />
              </label>
            </div>
            <ErrorNote error={create.error} />
            <div>
              <button className="btn btn-primary" disabled={create.busy}>
                {create.busy ? 'Creando…' : 'Crear tarea'}
              </button>
            </div>
          </form>
        </section>
      )}
      <section className="panel">
        <div className="filters">
          <label className="field">
            <span className="field-label">Estado</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Todas</option>
              {Object.entries(TASK_STATUS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="check" style={{ alignSelf: 'center', marginTop: 18 }}>
            <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> Solo vencidas
          </label>
        </div>
        <ErrorNote error={list.error ?? update.error} />
        {list.loading && !list.data ? (
          <Loading />
        ) : list.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tarea</th>
                  <th>Responsable</th>
                  <th>Vence</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((t) => (
                  <tr key={t.id}>
                    <td style={{ minWidth: 240 }}>
                      <strong>{t.title}</strong>
                      <span className="sub">
                        {t.norm_number}, {t.process_code}
                      </span>
                      {t.evidence && <span className="sub">Evidencia: {t.evidence}</span>}
                      {closing === t.id && (
                        <form
                          className="form"
                          style={{ marginTop: 8, gap: 8 }}
                          onSubmit={(e) => {
                            e.preventDefault();
                            patch(t.id, { status: 'cerrada', ...(evidence.trim() ? { evidence: evidence.trim() } : {}) });
                          }}
                        >
                          <label className="field">
                            <span className="field-label">Evidencia de cierre (opcional)</span>
                            <textarea rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Manual v3 aprobado en comité del 20/10" />
                          </label>
                          <div className="page-actions">
                            <button className="btn btn-primary btn-sm" disabled={update.busy}>
                              Cerrar tarea
                            </button>
                            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setClosing(null)}>
                              Cancelar
                            </button>
                          </div>
                        </form>
                      )}
                    </td>
                    <td>{t.responsible_email}</td>
                    <td className="nowrap">
                      {fmtDay(t.due_at)}
                      {t.overdue && (
                        <span className="sub">
                          <Badge tone="red">Vencida</Badge>
                        </span>
                      )}
                    </td>
                    <td>
                      <Badge tone={t.status === 'cerrada' ? 'green' : t.status === 'en_progreso' ? 'blue' : 'amber'}>{labelOf(TASK_STATUS, t.status)}</Badge>
                    </td>
                    <td>
                      {t.status !== 'cerrada' && closing !== t.id && (
                        <div className="page-actions">
                          {t.status === 'abierta' && (
                            <button type="button" className="btn btn-quiet btn-sm" disabled={update.busy} onClick={() => patch(t.id, { status: 'en_progreso' })}>
                              Empezar
                            </button>
                          )}
                          <button type="button" className="btn btn-quiet btn-sm" onClick={() => (setClosing(t.id), setEvidence(''))}>
                            Cerrar
                          </button>
                        </div>
                      )}
                      {t.status === 'cerrada' && <span className="muted small">Cerrada el {fmtDay(t.closed_at)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No hay tareas con estos filtros. Cree una desde la matriz de impacto.</Empty>
        )}
      </section>
    </div>
  );
}
