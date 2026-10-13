import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, apiBlob, type SimMessage, type SimState } from '../api';
import { Inspector, buildMarks, orderFindings } from '../Inspector';
import { FindingsList } from '../Report';
import {
  Badge,
  Bear,
  Empty,
  ErrorNote,
  Facts,
  Loading,
  PageHead,
  Tabs,
  daysUntil,
  fmtDateTime,
  fmtDay,
  humanize,
  labelOf,
  useAction,
  useApi,
  type Tone,
} from '../ui';

const STATUS: Record<string, [string, Tone]> = {
  borrador: ['Borrador', 'muted'],
  cancelado: ['Cancelado', 'muted'],
  revision_analista: ['Revisión del analista', 'amber'],
  ajustador: ['Con el ajustador', 'blue'],
  aclaracion: ['Aclaración pedida', 'amber'],
  aprobado: ['Aprobado', 'green'],
  rechazado: ['Rechazado', 'red'],
  consentido: ['Consentido', 'red'],
};
const RISK: Record<string, [string, Tone]> = { alto: ['Riesgo alto', 'red'], medio: ['Riesgo medio', 'amber'], bajo: ['Riesgo bajo', 'green'] };
const ALERTS: Record<string, string> = { dia_20: 'Día 20', dia_25: 'Día 25', dia_28: 'Día 28', consentido: 'Consentido' };

const StatusBadge = ({ s }: { s: string }) => <Badge tone={STATUS[s]?.[1] ?? 'muted'}>{STATUS[s]?.[0] ?? humanize(s)}</Badge>;
const RiskBadge = ({ r }: { r: string | null }) => (r ? <Badge tone={RISK[r]?.[1] ?? 'muted'}>{RISK[r]?.[0] ?? r}</Badge> : <span className="muted">—</span>);

/** Etiquetas configuradas por la aseguradora: tipos de siniestro y documentos requeridos. */
function useClaimLabels() {
  const cfg = useApi<any>('/v1/claims/config');
  return useMemo(() => {
    const types: Record<string, string> = {};
    const docs: Record<string, string> = {};
    for (const t of cfg.data?.claim_types ?? []) {
      types[t.code] = t.label;
      for (const d of t.required_docs ?? []) docs[d.code] = d.label;
    }
    return { types, docs };
  }, [cfg.data]);
}

export function Claims({ parts }: { parts: string[] }) {
  const alerts = useApi<any[]>('/v1/claims/alerts');
  const tab = parts[0] === 'alertas' ? '/app/siniestros/alertas' : parts[0] === 'simulador' ? '/app/siniestros/simulador' : '/app/siniestros';
  let body;
  if (parts[0] === 'alertas') body = <Alerts list={alerts} />;
  else if (parts[0] === 'simulador') body = <Simulator />;
  else if (parts[0]) body = <ClaimDetail id={parts[0]} onChanged={alerts.reload} />;
  else body = <ClaimList />;
  return (
    <>
      <PageHead title="Siniestros" sub="Avisos recibidos por WhatsApp, con fotos verificadas y el plazo SBS de cada caso." />
      <Tabs
        current={tab}
        items={[
          { href: '/app/siniestros', label: 'Casos' },
          { href: '/app/siniestros/alertas', label: 'Alertas de plazo', count: alerts.data?.length },
          { href: '/app/siniestros/simulador', label: 'Simulador de WhatsApp' },
        ]}
      />
      {body}
    </>
  );
}

// ---------------------------------------------------------------- lista y alertas

function Deadline({ c }: { c: any }) {
  if (['aprobado', 'rechazado', 'cancelado', 'borrador'].includes(c.status)) return <span className="muted">—</span>;
  if (c.status === 'consentido') return <Badge tone="red">Consentido</Badge>;
  if (!c.consent_deadline) return <span className="muted">Esperando documentos</span>;
  const d = daysUntil(c.consent_deadline) ?? 0;
  return (
    <>
      {fmtDay(c.consent_deadline)}
      <span className="sub">
        <Badge tone={d <= 5 ? 'red' : d <= 10 ? 'amber' : 'muted'}>{d < 0 ? 'vencido' : `quedan ${d} días`}</Badge>
      </span>
    </>
  );
}

function ClaimList() {
  const [status, setStatus] = useState('');
  const [risk, setRisk] = useState('');
  const [due, setDue] = useState('');
  const { types } = useClaimLabels();
  const list = useApi<any[]>('/v1/claims', { status: status || undefined, risk: risk || undefined, due_within_days: due || undefined });
  return (
    <section className="panel">
      <div className="filters">
        <label className="field">
          <span className="field-label">Estado</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option>
            {Object.entries(STATUS).map(([v, [l]]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Riesgo</span>
          <select value={risk} onChange={(e) => setRisk(e.target.value)}>
            <option value="">Todos</option>
            <option value="alto">Alto</option>
            <option value="medio">Medio</option>
            <option value="bajo">Bajo</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Plazo de 30 días</span>
          <select value={due} onChange={(e) => setDue(e.target.value)}>
            <option value="">Cualquiera</option>
            <option value="5">Vence en 5 días</option>
            <option value="10">Vence en 10 días</option>
          </select>
        </label>
      </div>
      <ErrorNote error={list.error} />
      {list.loading && !list.data ? (
        <Loading />
      ) : list.data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Siniestro</th>
                <th>Tipo</th>
                <th>Estado</th>
                <th>Riesgo</th>
                <th>Plazo para pronunciarse</th>
                <th>Primer mensaje</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id} className="row-link">
                  <td>
                    <a className="row-title" href={`#/app/siniestros/${c.id}`}>
                      {c.number}
                    </a>
                    <span className="sub">
                      {c.holder_name ?? 'Sin identificar'}
                      {c.policy_number ? `, póliza ${c.policy_number}` : ''}
                    </span>
                  </td>
                  <td>
                    {labelOf(types, c.claim_type)}
                    {c.late_notice && (
                      <span className="sub">
                        <Badge tone="amber">Aviso tardío</Badge>
                      </span>
                    )}
                  </td>
                  <td>
                    <StatusBadge s={c.status} />
                  </td>
                  <td>
                    <RiskBadge r={c.risk_level} />
                    {c.risk_score != null && <span className="sub">{c.risk_score} de 100</span>}
                  </td>
                  <td className="nowrap">
                    <Deadline c={c} />
                  </td>
                  <td className="nowrap">{fmtDateTime(c.first_contact_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>
          No hay siniestros con estos filtros. Pruebe el bot en el <a href="#/app/siniestros/simulador">simulador de WhatsApp</a>.
        </Empty>
      )}
    </section>
  );
}

function Alerts({ list }: { list: ReturnType<typeof useApi<any[]>> }) {
  return (
    <section className="panel">
      <p className="muted small" style={{ marginBottom: 12 }}>
        Sin ajustador, la aseguradora tiene 30 días desde la documentación completa para aprobar o rechazar, y solo puede pedir aclaraciones en
        los primeros 20 (Res. SBS 3202-2013). Si no responde, el siniestro queda consentido.
      </p>
      <ErrorNote error={list.error} />
      {list.loading && !list.data ? (
        <Loading />
      ) : list.data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Alerta</th>
                <th>Siniestro</th>
                <th>Estado</th>
                <th>Vence</th>
                <th>Emitida</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((a, i) => (
                <tr key={i}>
                  <td style={{ minWidth: 240 }}>
                    <Badge tone={a.kind === 'consentido' || a.kind === 'dia_28' ? 'red' : 'amber'}>{labelOf(ALERTS, a.kind)}</Badge>
                    <span className="sub" style={{ color: 'var(--ink)' }}>
                      {a.message}
                    </span>
                  </td>
                  <td>
                    <a className="row-title" href={`#/app/siniestros/${a.claim_id}`}>
                      {a.number}
                    </a>
                  </td>
                  <td>
                    <StatusBadge s={a.status} />
                  </td>
                  <td className="nowrap">{fmtDateTime(a.due_at ?? a.consent_deadline)}</td>
                  <td className="nowrap">{fmtDateTime(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No hay alertas de plazo. Ningún siniestro está cerca del día 20.</Empty>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- detalle

function DeadlinePanel({ c }: { c: any }) {
  const d = c.deadlines ?? {};
  const day = Math.max(0, Math.min(30, d.day_count ?? 0));
  return (
    <section className="panel">
      <h2>Plazos SBS</h2>
      {d.docs_complete_at ? (
        <>
          <p>
            Día <strong>{d.day_count}</strong> de 30 desde la documentación completa.
          </p>
          <div className="deadline-bar" aria-hidden="true">
            <span style={{ width: `${(day / 30) * 100}%` }} />
            <i style={{ left: `${(20 / 30) * 100}%` }} />
          </div>
          <div className="deadline-legend" aria-hidden="true">
            <span>Día 0</span>
            <span>Día 20: último para aclaraciones</span>
            <span>Día 30</span>
          </div>
        </>
      ) : (
        <p className="muted">El plazo de 30 días empieza cuando la documentación está completa.</p>
      )}
      <div style={{ marginTop: 14 }}>
        <Facts
          items={[
            ['Plazo de aviso', `${d.notice_days ?? '—'} días: hasta el ${fmtDateTime(d.notice_deadline)}`],
            ['Aviso', d.late_notice ? <Badge key="l" tone="amber">Tardío</Badge> : 'Dentro del plazo'],
            ['Documentación completa', fmtDateTime(d.docs_complete_at)],
            ['Aclaraciones hasta', d.can_request_clarification ? fmtDateTime(d.clarification_cutoff) : `Cerrado (${fmtDay(d.clarification_cutoff)})`],
            ['Pronunciarse hasta', fmtDateTime(d.consent_deadline)],
            ['Pago hasta', fmtDateTime(d.payment_deadline)],
          ]}
        />
      </div>
      {d.alerts?.length > 0 && (
        <ul style={{ margin: '14px 0 0', paddingLeft: 18 }}>
          {d.alerts.map((a: any, i: number) => (
            <li key={i}>
              <strong>{labelOf(ALERTS, a.kind)}:</strong> {a.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ClaimFile({ claimId, f, docLabel }: { claimId: string; f: any; docLabel: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const isImage = /^image\/(jpeg|png|webp|gif)$/.test(f.mime_type);
  const findings = useMemo(() => orderFindings(f.findings ?? []), [f.findings]);
  const report = useMemo(() => ({ findings, extracted_fields: null, ocr: null }), [findings]);
  const marks = useMemo(() => buildMarks(findings, []), [findings]);

  useEffect(() => {
    let u: string | null = null;
    apiBlob(`/v1/claims/${claimId}/files/${f.id}`).then(
      (b) => setUrl((u = URL.createObjectURL(b))),
      (e) => setErr(e.message),
    );
    return () => void (u && URL.revokeObjectURL(u));
  }, [claimId, f.id]);

  const title = f.kind === 'photo' ? 'Foto del daño' : f.doc_type ? docLabel : 'Documento adjunto';
  return (
    <article className="panel" style={{ padding: 14 }}>
      <h3 className="h-small" style={{ marginTop: 0 }}>
        {title}
      </h3>
      <p className="muted small" style={{ marginBottom: 10 }}>
        {f.source === 'capture' ? 'Tomada con la cámara en vivo' : 'Enviada por WhatsApp'}, {fmtDateTime(f.created_at)}.
        {f.capture &&
          ` GPS a ${f.capture.distance_km != null ? `${f.capture.distance_km} km` : '—'} del lugar declarado (precisión ${f.capture.accuracy_m ?? '—'} m), desfase de hora ${f.capture.drift_seconds ?? '—'} s.`}
      </p>
      {err && <ErrorNote>No se pudo cargar el archivo: {err}</ErrorNote>}
      {isImage ? (
        url ? (
          <Inspector src={url} report={report} animate={false} active={active} onActive={setActive} label={title} tools={false} />
        ) : (
          !err && <Loading text="Cargando…" />
        )
      ) : (
        url && (
          <a className="btn btn-quiet btn-sm" href={url} target="_blank" rel="noopener">
            Abrir el archivo
          </a>
        )
      )}
      <div style={{ marginTop: 12 }}>
        <FindingsList findings={findings} marks={marks} active={active} onActive={setActive} />
      </div>
    </article>
  );
}

function ClaimActions({ c, onDone }: { c: any; onDone: () => void }) {
  const isReview = c.status === 'revision_analista';
  const canDecide = ['ajustador', 'aclaracion', 'consentido'].includes(c.status);
  const [choice, setChoice] = useState('');
  const [note, setNote] = useState('');
  const act = useAction();
  const [ok, setOk] = useState<string | null>(null);
  if (!isReview && !canDecide) return null;

  const options: Record<string, string> = isReview
    ? { approve_to_adjuster: 'Enviar al ajustador', request_info: 'Pedir información al asegurado', reject: 'Rechazar' }
    : c.status === 'consentido'
      ? { aprobado: 'Aprobar y pagar' }
      : { aprobado: 'Aprobar', aclaracion: 'Pedir aclaración', rechazado: 'Rechazar' };
  const needsNote = ['reject', 'request_info', 'rechazado', 'aclaracion'].includes(choice);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = isReview ? { action: choice } : { decision: choice };
    if (note.trim()) body.note = note.trim();
    const r = await act.run(() => api(`/v1/claims/${c.id}/${isReview ? 'review' : 'decision'}`, { body }));
    if (r) {
      setOk(`Listo: ${options[choice].toLowerCase()}.${needsNote || choice === 'aprobado' ? ' Se avisó al asegurado por WhatsApp.' : ''}`);
      setChoice('');
      setNote('');
      onDone();
    }
  };

  return (
    <section className="panel">
      <h2>{isReview ? 'Revisión del analista' : 'Decisión del ajustador'}</h2>
      <p className="muted small" style={{ marginBottom: 12 }}>
        {isReview
          ? 'Es un caso de riesgo alto: un analista lo revisa antes de que llegue al ajustador.'
          : c.status === 'consentido'
            ? 'El plazo venció sin respuesta: el siniestro quedó consentido y debe pagarse.'
            : 'El asegurado recibe la decisión por WhatsApp.'}
      </p>
      {ok && (
        <p className="note note-ok" role="status" style={{ marginBottom: 12 }}>
          {ok}
        </p>
      )}
      <form className="form" onSubmit={submit}>
        <fieldset className="field">
          <legend className="sr-only">Acción</legend>
          <div className="radio-row">
            {Object.entries(options).map(([v, l]) => (
              <label key={v}>
                <input type="radio" name="claim-action" value={v} checked={choice === v} onChange={() => setChoice(v)} required />
                {l}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span className="field-label">{needsNote ? 'Motivo o información que falta' : 'Nota (opcional)'}</span>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} required={needsNote} maxLength={4000} />
          {needsNote && <span className="field-hint">El asegurado lo recibe tal cual en el chat.</span>}
        </label>
        {act.error && (
          <p className="note note-error" role="alert">
            {act.error.status === 422 ? 'No se puede pedir la aclaración. ' : ''}
            {act.error.message}
          </p>
        )}
        <div>
          <button className="btn btn-primary" disabled={!choice || (needsNote && !note.trim()) || act.busy}>
            {act.busy ? 'Guardando…' : 'Confirmar'}
          </button>
        </div>
      </form>
    </section>
  );
}

function ClaimDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const c = useApi<any>(`/v1/claims/${id}`);
  const { types, docs } = useClaimLabels();
  const d = c.data;
  const loc = d?.location;
  return (
    <>
      <a className="crumb" href="#/app/siniestros">
        Siniestros
      </a>
      <ErrorNote error={c.error} />
      {c.loading && !d && <Loading />}
      {d && (
        <>
          <div className="panel-row" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 22 }}>
              {d.number} <span className="muted" style={{ fontWeight: 400, fontSize: 17 }}>{labelOf(types, d.claim_type)}</span>
            </h2>
            <span className="page-actions">
              <StatusBadge s={d.status} />
              <RiskBadge r={d.risk_level} />
            </span>
          </div>
          <div className="grid-doc">
            <div className="stack">
              <section className="panel">
                <h2>Asegurado y póliza</h2>
                <Facts
                  items={[
                    ['Asegurado', d.holder_name ?? '—'],
                    ['DNI', d.holder_dni ?? '—'],
                    ['Póliza', d.policy_number ?? '—'],
                    ['Producto', d.policy?.product ?? '—'],
                    ['Placa', d.policy?.plate ?? '—'],
                    ['Vigencia', d.policy ? `${fmtDay(d.policy.start_date)} al ${fmtDay(d.policy.end_date)}` : '—'],
                    ['Ramo', d.line === 'daños' ? 'Daños' : d.line === 'personas' ? 'Personas' : (d.line ?? '—')],
                    ['WhatsApp', d.wa_id ? `+${d.wa_id}` : '—'],
                  ]}
                />
              </section>
              <section className="panel">
                <h2>Qué pasó</h2>
                <Facts
                  items={[
                    ['Ocurrió', fmtDateTime(d.occurred_at)],
                    [
                      'Lugar',
                      loc ? (
                        <>
                          {loc.name ?? loc.address ?? 'Ubicación enviada'}
                          {loc.lat != null && (
                            <>
                              {' '}
                              <a href={`https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=17/${loc.lat}/${loc.lng}`} target="_blank" rel="noopener noreferrer">
                                Ver mapa
                              </a>
                            </>
                          )}
                        </>
                      ) : (
                        '—'
                      ),
                    ],
                    ['Primer mensaje', fmtDateTime(d.first_contact_at)],
                    ['Documentos faltantes', d.missing_docs?.length ? d.missing_docs.map((x: string) => labelOf(docs, x)).join(', ') : 'Ninguno'],
                  ]}
                />
                {d.narrative && (
                  <blockquote style={{ margin: '14px 0 0', paddingLeft: 14, borderLeft: '3px solid var(--cream)' }}>{d.narrative}</blockquote>
                )}
              </section>
              {d.files?.length > 0 && (
                <section aria-label="Fotos y documentos">
                  <h2 className="h-small" style={{ marginTop: 0 }}>
                    Fotos y documentos verificados
                  </h2>
                  <div className="photos">
                    {d.files.map((f: any) => (
                      <ClaimFile key={f.id} claimId={id} f={f} docLabel={labelOf(docs, f.doc_type)} />
                    ))}
                  </div>
                </section>
              )}
              <section className="panel">
                <h2>Conversación</h2>
                <div className="chat" style={{ maxHeight: 520, borderRadius: 8 }}>
                  <ChatLog messages={d.transcript ?? []} />
                </div>
              </section>
            </div>
            <div className="stack sticky">
              <DeadlinePanel c={d} />
              <section className="panel">
                <h2>Riesgo</h2>
                <p>
                  <RiskBadge r={d.risk_level} /> {d.risk_score != null && <span className="muted">{d.risk_score} de 100</span>}
                </p>
                {d.risk_reasons?.length ? (
                  <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
                    {d.risk_reasons.map((r: string, i: number) => (
                      <li key={i}>{r.replace(/^[a-z_.]+:\s*/, '')}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted" style={{ marginTop: 8 }}>
                    Sin señales de riesgo.
                  </p>
                )}
              </section>
              <ClaimActions
                c={d}
                onDone={() => {
                  c.reload();
                  onChanged();
                }}
              />
              {(d.review_action || d.decision) && (
                <section className="panel">
                  <h2>Historial de decisiones</h2>
                  <Facts
                    items={[
                      ['Revisión del analista', d.review_action ? `${humanize(d.review_action)}${d.review_note ? `: ${d.review_note}` : ''}` : '—'],
                      ['Decisión', d.decision ? `${humanize(d.decision)}${d.decision_note ? `: ${d.decision_note}` : ''}` : '—'],
                      ['Decidido', fmtDateTime(d.decided_at)],
                    ]}
                  />
                </section>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- chat

const URL_RE = /(https?:\/\/[^\s]+)/g;

function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer">
            {/\/capture\//.test(p) ? 'Abrir la cámara para tomar las fotos' : p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

const time = (s: string) => new Date(s).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false });

function inboundText(m: Pick<SimMessage, 'type' | 'body' | 'payload'>): ReactNode {
  if (m.type === 'location') {
    const i = m.payload?.input;
    return `Ubicación: ${i?.name ?? m.body ?? ''}${i?.lat != null ? ` (${Number(i.lat).toFixed(4)}, ${Number(i.lng).toFixed(4)})` : ''}`;
  }
  if (m.type === 'image') return <span className="bubble-media">Imagen{m.body ? `: ${m.body}` : ''}</span>;
  if (m.type === 'document') return <span className="bubble-media">Documento{m.body ? `: ${m.body}` : ''}</span>;
  if (m.type === 'audio') return <span className="bubble-media">Nota de voz</span>;
  return m.body ?? '';
}

function ChatLog({
  messages,
  onReply,
  activeFrom = Infinity,
}: {
  messages: Pick<SimMessage, 'direction' | 'type' | 'body' | 'payload' | 'at'>[];
  onReply?: (id: string, title: string) => void;
  activeFrom?: number;
}) {
  const [openList, setOpenList] = useState<number | null>(null);
  if (!messages.length) return <p className="chat-day">Sin mensajes todavía</p>;
  return (
    <>
      {messages.map((m, i) => {
        const p = m.payload ?? {};
        const interactive = !!onReply && i >= activeFrom;
        return (
          <div key={i} className={`bubble ${m.direction}`}>
            {m.direction === 'in' ? inboundText(m) : <Linkified text={p.text ?? m.body ?? ''} />}
            {m.direction === 'out' && m.type === 'buttons' && p.buttons?.length > 0 && (
              <div className="bubble-opts">
                {p.buttons.map((b: any) => (
                  <button key={b.id} type="button" disabled={!interactive} onClick={() => onReply?.(b.id, b.title)}>
                    {b.title}
                  </button>
                ))}
              </div>
            )}
            {m.direction === 'out' && m.type === 'list' && p.rows?.length > 0 && (
              <div className="bubble-opts">
                <button type="button" disabled={!interactive} aria-expanded={openList === i} onClick={() => setOpenList(openList === i ? null : i)}>
                  {p.button ?? 'Ver opciones'}
                </button>
                {openList === i &&
                  interactive &&
                  p.rows.map((r: any) => (
                    <button key={r.id} type="button" onClick={() => (setOpenList(null), onReply?.(r.id, r.title))}>
                      {r.title}
                      {r.description && <small>{r.description}</small>}
                    </button>
                  ))}
              </div>
            )}
            <time dateTime={m.at}>{time(m.at)}</time>
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------- simulador

const SIM_KEY = 'ukuk.sim.from';
const randomPhone = () => `519${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const LIMA = { lat: -12.1211, lng: -77.0297, name: 'Óvalo de Miraflores, Lima' };

function readFrom(): string {
  try {
    const v = localStorage.getItem(SIM_KEY);
    if (v && /^\d{8,15}$/.test(v)) return v;
  } catch {
    /* sin almacenamiento */
  }
  return randomPhone();
}

function Simulator() {
  const [from, setFrom] = useState(readFrom);
  const [state, setState] = useState<SimState | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locMenu, setLocMenu] = useState(false);
  const [pending, setPending] = useState<SimMessage | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(SIM_KEY, from);
    } catch {
      /* sin almacenamiento */
    }
    let live = true;
    setState(null);
    api<SimState>('/v1/claims/simulator', { query: { from } }).then(
      (s) => live && setState(s),
      (e) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [from]);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state, pending, busy]);

  const send = async (payload: Record<string, unknown>, preview: Partial<SimMessage>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setPending({ id: 'tmp', direction: 'in', type: 'text', body: '', payload: null, file_id: null, at: new Date().toISOString(), ...preview });
    try {
      setState(await api<SimState>('/v1/claims/simulator', { body: { from, name: 'Asegurado de prueba', ...payload } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
      setBusy(false);
    }
  };

  const sendText = (t: string) => {
    const v = t.trim();
    if (!v) return;
    setText('');
    send({ text: v }, { body: v });
  };

  const sendLocation = (useGps: boolean) => {
    setLocMenu(false);
    const fixed = () => send({ location: LIMA }, { type: 'location', body: LIMA.name, payload: { input: LIMA } });
    if (!useGps || !navigator.geolocation) return fixed();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6), name: 'Mi ubicación' };
        send({ location: loc }, { type: 'location', body: loc.name, payload: { input: loc } });
      },
      () => {
        setError('El navegador no compartió la ubicación; se envió el punto fijo de Lima.');
        fixed();
      },
      { timeout: 6000, maximumAge: 60_000 },
    );
  };

  const attach = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return setError('WhatsApp acepta imágenes de hasta 5 MB. Elija un archivo más liviano.');
    const kind = file.type.startsWith('image/') ? 'image' : 'document';
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).split(',')[1] ?? '';
      send(
        { media: { kind, mime_type: file.type || 'application/octet-stream', data_base64: data, filename: file.name.slice(0, 200) } },
        { type: kind, body: file.name },
      );
    };
    reader.readAsDataURL(file);
    if (fileRef.current) fileRef.current.value = '';
  };

  const messages = state?.messages ?? [];
  const lastIn = messages.map((m) => m.direction).lastIndexOf('in');
  const closed = state?.conversation?.status === 'closed';
  const shown = pending ? [...messages, pending] : messages;

  return (
    <div className="sim">
      <div className="phone" aria-label="Simulador de WhatsApp">
        <div className="phone-head">
          <Bear size={34} inverse />
          <div>
            <strong>Asistente de siniestros</strong>
            <span>Simulador, sin enviar nada a Meta</span>
          </div>
        </div>
        <div className="chat" ref={chatRef} aria-live="polite" aria-relevant="additions">
          {!state && !error && <Loading />}
          {state && (
            <ChatLog
              messages={shown}
              activeFrom={closed || busy ? Infinity : lastIn + 1}
              onReply={(id, title) => send({ reply_id: id, reply_title: title }, { type: 'interactive', body: title })}
            />
          )}
          {busy && <span className="typing">escribiendo…</span>}
        </div>
        {locMenu && (
          <div className="sim-menu" role="menu" aria-label="Enviar ubicación">
            <button type="button" className="chip" role="menuitem" onClick={() => sendLocation(true)}>
              Mi ubicación (GPS del navegador)
            </button>
            <button type="button" className="chip" role="menuitem" onClick={() => sendLocation(false)}>
              Punto fijo: Óvalo de Miraflores
            </button>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            sendText(text);
          }}
        >
          <button type="button" className="icon-btn" aria-label="Adjuntar foto o documento" title="Adjuntar foto o documento" onClick={() => fileRef.current?.click()} disabled={busy}>
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M16.5 6.5 8.7 14.3a2 2 0 0 0 2.8 2.8l7.8-7.8a4 4 0 0 0-5.6-5.6L5.6 11.8a6 6 0 0 0 8.5 8.5l6.4-6.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Enviar ubicación"
            title="Enviar ubicación"
            aria-expanded={locMenu}
            onClick={() => setLocMenu(!locMenu)}
            disabled={busy}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" fill="none" stroke="currentColor" strokeWidth="2" />
              <circle cx="12" cy="9.5" r="2.5" fill="currentColor" />
            </svg>
          </button>
          <input type="file" ref={fileRef} className="sr-only" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => attach(e.target.files?.[0])} tabIndex={-1} aria-hidden="true" />
          <label className="sr-only" htmlFor="sim-text">
            Mensaje
          </label>
          <input id="sim-text" type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Escriba un mensaje" autoComplete="off" maxLength={4096} />
          <button className="icon-btn is-send" aria-label="Enviar" title="Enviar" disabled={busy || !text.trim()}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 12 20 4l-6 16-2.5-6.5L4 12Z" fill="currentColor" />
            </svg>
          </button>
        </form>
      </div>

      <div className="stack">
        <section className="panel">
          <h2>Conversación de prueba</h2>
          <Facts
            items={[
              ['Número simulado', `+${from}`],
              ['Estado', state?.conversation ? (closed ? 'Cerrada' : 'Abierta') : 'Sin iniciar'],
              ['Mensajes', state?.conversation?.message_count ?? 0],
            ]}
          />
          {state?.conversation?.claim_id && (
            <p className="note note-ok" style={{ marginTop: 12 }}>
              Esta conversación tiene un siniestro. <a href={`#/app/siniestros/${state.conversation.claim_id}`}>Abrir la ficha</a>
            </p>
          )}
          {error && (
            <p className="note note-error" role="alert" style={{ marginTop: 12 }}>
              {error}
            </p>
          )}
          <p style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-primary" onClick={() => setFrom(randomPhone())} disabled={busy}>
              Nueva conversación
            </button>
          </p>
        </section>
        <section className="panel">
          <h2>Cómo probar</h2>
          <p className="small" style={{ marginBottom: 10 }}>
            Las pólizas de prueba responden al DNI <strong>45678912</strong> o a la placa <strong>ABC-123</strong>. El flujo y los plazos son los
            reales; solo no se envía nada a Meta. Las fotos se toman con el enlace de captura, que abre la cámara en una pestaña nueva.
          </p>
          <div className="chips" aria-label="Mensajes rápidos">
            {['Hola', '45678912', 'ABC-123', 'ayer 10:30', 'Me chocaron por detrás en un semáforo', 'AYUDA', 'CANCELAR'].map((t) => (
              <button key={t} type="button" className="chip" disabled={busy} onClick={() => sendText(t)}>
                {t}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
