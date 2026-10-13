import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api, apiBlob, ApiError, session, type DocListItem, type DocReport, type Page } from '../api';
import { Inspector, buildMarks, orderFindings } from '../Inspector';
import { FieldsTable, FindingsList } from '../Report';
import {
  Badge,
  DOC_TYPES,
  ErrorNote,
  FIELDS,
  Facts,
  LEVELS,
  Loading,
  PageHead,
  Pager,
  ScoreScale,
  VerdictBadge,
  fmtDateTime,
  labelOf,
  useAction,
  useApi,
} from '../ui';

const PREVIEWABLE = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp'];
const INVOICE_FIELDS = ['total', 'subtotal', 'igv', 'fecha_emision', 'ruc_emisor', 'serie_numero'];
const fieldsFor = (t: string) =>
  t === 'dni' ? ['dni', 'mrz'] : ['boleta_venta', 'factura', 'recibo_servicio', 'boleta_pago'].includes(t) ? INVOICE_FIELDS : [...INVOICE_FIELDS, 'dni', 'mrz'];

const REVIEWS: Record<string, string> = { aprobado: 'Aprobado', rechazado: 'Rechazado', legitimo: 'Legítimo' };

export function Documents({ parts, path }: { parts: string[]; path: string }) {
  if (parts[0]) return <DocumentDetail id={parts[0]} />;
  return <DocumentsHome pendingOnly={/[?&]pendientes=1/.test(path)} />;
}

function DocumentsHome({ pendingOnly }: { pendingOnly: boolean }) {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <>
      <PageHead title="Documentos" sub="Suba un documento para analizarlo o revise los que ya pasaron por el motor." />
      <Upload onAnalyzed={() => setReloadKey((n) => n + 1)} />
      <DocumentList reloadKey={reloadKey} pendingOnly={pendingOnly} />
    </>
  );
}

// ---------------------------------------------------------------- subir

interface Run {
  n: number;
  url: string | null;
  isPdf: boolean;
  name: string;
  report: DocReport | null;
  error: ApiError | null;
}

function Upload({ onAnalyzed }: { onAnalyzed: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState('');
  const [level, setLevel] = useState('verification');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [ref, setRef] = useState('');
  const [over, setOver] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => void (run?.url && URL.revokeObjectURL(run.url)), [run?.url]);

  const pick = (f: File | undefined | null) => {
    if (f) setFile(f);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files?.[0]);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const isImage = PREVIEWABLE.includes(file.type);
    const n = (run?.n ?? 0) + 1;
    setRun({ n, url: isImage ? URL.createObjectURL(file) : null, isPdf: file.type === 'application/pdf', name: file.name, report: null, error: null });
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    const form = new FormData();
    form.append('file', file);
    if (type) form.append('document_type', type);
    form.append('level', level);
    const provided = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v.trim() && fieldsFor(type).includes(k)));
    if (Object.keys(provided).length) form.append('fields', JSON.stringify(provided));
    if (ref.trim()) form.append('external_ref', ref.trim());
    try {
      const report = await api<DocReport>('/v1/documents', { form });
      setRun((r) => (r && r.n === n ? { ...r, report: { ...report, findings: orderFindings(report.findings ?? []) } } : r));
      onAnalyzed();
    } catch (err) {
      setRun((r) => (r && r.n === n ? { ...r, error: err as ApiError } : r));
    }
  };

  return (
    <section className="panel" aria-labelledby="up-title">
      <h2 id="up-title">Analizar un documento</h2>
      <form className="form" onSubmit={submit}>
        <div
          className={`drop${over ? ' is-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
        >
          {file ? (
            <span className="file-chip">
              {file.name} <span>({Math.round(file.size / 1024)} KB)</span>
            </span>
          ) : (
            <strong>Arrastre aquí una imagen o un PDF</strong>
          )}
          <span>
            JPG, PNG, WEBP, HEIC, TIFF, PDF o XML SUNAT, hasta 25 MB.{' '}
            <button type="button" className="btn-link" onClick={(e) => (e.stopPropagation(), inputRef.current?.click())}>
              {file ? 'Cambiar archivo' : 'Elegir archivo'}
            </button>
          </span>
          <input
            ref={inputRef}
            type="file"
            className="sr-only"
            aria-label="Archivo del documento"
            accept="image/*,application/pdf,.xml,text/xml,application/xml,.heic,.tif,.tiff"
            onChange={(e) => pick(e.target.files?.[0])}
          />
        </div>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Tipo de documento</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Detectar automáticamente</option>
              {Object.entries(DOC_TYPES).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Nivel de análisis</span>
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              {Object.entries(LEVELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Referencia interna (opcional)</span>
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="N.° de reclamo o expediente" maxLength={200} />
          </label>
        </div>
        <details className="disclose">
          <summary>Datos impresos del documento (opcional)</summary>
          <div>
            <p className="muted small" style={{ marginBottom: 10 }}>
              Escríbalos tal como aparecen impresos, o como ya los capturó su sistema. El motor revisa que sean consistentes (sumas, IGV,
              RUC, fechas, MRZ) y los usa para consultar las fuentes oficiales.
            </p>
            <div className="form-grid">
              {fieldsFor(type).map((k) => (
                <label key={k} className={`field${k === 'mrz' ? ' field-wide' : ''}`}>
                  <span className="field-label">{FIELDS[k]}</span>
                  {k === 'mrz' ? (
                    <textarea
                      rows={3}
                      className="mono"
                      value={fields[k] ?? ''}
                      onChange={(e) => setFields({ ...fields, [k]: e.target.value.toUpperCase() })}
                      placeholder={'I<PER45678912<4<<<<<<<<<<<<<<<\n…'}
                      spellCheck={false}
                    />
                  ) : (
                    <input
                      type={k === 'fecha_emision' ? 'date' : 'text'}
                      inputMode={['total', 'subtotal', 'igv'].includes(k) ? 'decimal' : ['ruc_emisor', 'dni'].includes(k) ? 'numeric' : undefined}
                      value={fields[k] ?? ''}
                      onChange={(e) => setFields({ ...fields, [k]: e.target.value })}
                      placeholder={{ total: '118.00', subtotal: '100.00', igv: '18.00', ruc_emisor: '20123456789', serie_numero: 'B001-00004321', dni: '45678912' }[k]}
                    />
                  )}
                </label>
              ))}
            </div>
          </div>
        </details>
        <div>
          <button className="btn btn-primary" disabled={!file || (!!run && !run.report && !run.error)}>
            {run && !run.report && !run.error ? 'Analizando…' : 'Analizar documento'}
          </button>
        </div>
      </form>

      {run && (
        <div ref={resultRef} style={{ marginTop: 20 }}>
          <ErrorNote error={run.error} />
          {!run.error && (
            <DocumentView
              key={run.n}
              report={run.report}
              imageUrl={run.url}
              pdfName={run.isPdf ? run.name : null}
              animate
              heading={run.name}
            />
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- lista

function DocumentList({ reloadKey, pendingOnly }: { reloadKey: number; pendingOnly: boolean }) {
  const [verdict, setVerdict] = useState(pendingOnly ? 'pendientes' : '');
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 20;
  const pending = verdict === 'pendientes';
  const query = {
    verdict: pending ? undefined : verdict || undefined,
    document_type: type || undefined,
    from: from || undefined,
    to: to ? `${to}T23:59:59.999-05:00` : undefined,
    limit: pending ? 100 : limit,
    offset: pending ? 0 : offset,
  };
  const list = useApi<Page<DocListItem>>('/v1/documents', query);
  useEffect(() => {
    if (reloadKey) list.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);
  useEffect(() => setOffset(0), [verdict, type, from, to]);
  const items = useMemo(() => {
    const all = list.data?.items ?? [];
    return pending ? all.filter((d) => (d.verdict === 'revisar' || d.verdict === 'rechazar') && !d.review_decision) : all;
  }, [list.data, pending]);

  return (
    <section className="panel" aria-labelledby="list-title">
      <h2 id="list-title">Documentos analizados</h2>
      <div className="filters">
        <label className="field">
          <span className="field-label">Veredicto</span>
          <select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
            <option value="">Todos</option>
            <option value="pendientes">Pendientes de revisión</option>
            <option value="aprobar">Aprobar</option>
            <option value="revisar">Revisar</option>
            <option value="rechazar">Rechazar</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Tipo</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Todos</option>
            {Object.entries(DOC_TYPES).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Desde</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Hasta</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
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
                <th>Documento</th>
                <th>Tipo</th>
                <th className="num">Riesgo</th>
                <th>Veredicto</th>
                <th>Revisión</th>
                <th>Recibido</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} className="row-link">
                  <td>
                    <a className="row-title" href={`#/app/documentos/${d.id}`}>
                      {d.filename ?? 'Sin nombre'}
                    </a>
                    <span className="sub">
                      {labelOf(LEVELS, d.level)}
                      {d.external_ref ? `, ref. ${d.external_ref}` : ''}
                    </span>
                  </td>
                  <td>{labelOf(DOC_TYPES, d.document_type)}</td>
                  <td className="num">{d.score ?? '—'}</td>
                  <td>
                    {d.status === 'completed' ? <VerdictBadge verdict={d.verdict} /> : <Badge tone={d.status === 'failed' ? 'red' : 'muted'}>{d.status === 'failed' ? 'Falló' : 'Procesando'}</Badge>}
                  </td>
                  <td>{d.review_decision ? <Badge tone="ink">{labelOf(REVIEWS, d.review_decision)}</Badge> : <span className="muted">Pendiente</span>}</td>
                  <td className="nowrap">{fmtDateTime(d.created_at)}</td>
                </tr>
              ))}
              {!items.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    {pending ? 'No hay documentos pendientes de revisión.' : 'No hay documentos con estos filtros.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {list.data && !pending && <Pager total={list.data.total} limit={limit} offset={offset} onPage={setOffset} />}
    </section>
  );
}

// ---------------------------------------------------------------- detalle

function DocumentDetail({ id }: { id: string }) {
  const doc = useApi<DocReport>(`/v1/documents/${id}`);
  const [url, setUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const mime = doc.data?.mime_type;

  useEffect(() => {
    if (!mime || !PREVIEWABLE.includes(mime)) return;
    let objectUrl: string | null = null;
    apiBlob(`/v1/documents/${id}/file`).then(
      (b) => setUrl((objectUrl = URL.createObjectURL(b))),
      (e: ApiError) => setFileError(e.message),
    );
    return () => void (objectUrl && URL.revokeObjectURL(objectUrl));
  }, [id, mime]);

  const report = useMemo(() => (doc.data ? { ...doc.data, id, findings: orderFindings(doc.data.findings ?? []) } : null), [doc.data, id]);

  return (
    <>
      <a className="crumb" href="#/app/documentos">
        Documentos
      </a>
      <ErrorNote error={doc.error} />
      {doc.loading && !doc.data && <Loading />}
      {report && (
        <>
          <PageHead
            title={report.filename ?? 'Documento'}
            sub={`${labelOf(DOC_TYPES, report.document_type)}, ${labelOf(LEVELS, report.level)}. Recibido el ${fmtDateTime(report.created_at)}.`}
          />
          {fileError && <ErrorNote>No se pudo cargar la imagen: {fileError}</ErrorNote>}
          {PREVIEWABLE.includes(report.mime_type) && !url && !fileError ? (
            <Loading text="Cargando la imagen…" />
          ) : (
            <DocumentView
              report={report}
              imageUrl={url}
              pdfName={PREVIEWABLE.includes(report.mime_type) ? null : (report.filename ?? 'documento')}
              docId={id}
              animate={false}
              onReviewed={doc.reload}
            />
          )}
        </>
      )}
    </>
  );
}

const SOURCES: Record<string, string> = {
  sunat_cpe: 'SUNAT, consulta de comprobantes',
  ruc: 'RUC (dígito de control)',
  reniec: 'RENIEC',
  renipress: 'RENIPRESS',
  cmp: 'Colegio Médico',
};
const SOURCE_STATUS: Record<string, [string, 'green' | 'muted' | 'red' | 'amber']> = {
  ok: ['Consultado', 'green'],
  not_configured: ['Sin credenciales', 'muted'],
  error: ['Error', 'red'],
  not_found: ['No encontrado', 'red'],
  skipped: ['Omitido', 'muted'],
};
const STAGES: Record<string, string> = {
  stored: 'Archivo recibido y cifrado',
  ocr: 'Lectura OCR',
  engine: 'Motor forense',
  external: 'Fuentes oficiales',
  scored: 'Puntaje calculado',
  failed: 'El análisis falló',
};

function stageDetail(s: Record<string, any>): string {
  if (s.stage === 'ocr') return [s.words !== undefined && `${s.words} palabras`, s.provider].filter(Boolean).join(', ');
  if (s.stage === 'engine') return [s.findings !== undefined && `${s.findings} hallazgos`, s.engine_version && `motor ${s.engine_version}`].filter(Boolean).join(', ');
  if (s.stage === 'external' && Array.isArray(s.sources))
    return s.sources.map((x: string) => {
      const [src, st] = x.split(':');
      return `${SOURCES[src] ?? src}: ${SOURCE_STATUS[st]?.[0].toLowerCase() ?? st}`;
    }).join('; ');
  return '';
}

/** Imagen con el inspector a la izquierda; informe y revisión a la derecha. */
export function DocumentView(props: {
  report: DocReport | null;
  imageUrl: string | null;
  pdfName: string | null;
  docId?: string;
  animate: boolean;
  heading?: string;
  onReviewed?: () => void;
}) {
  const { report, imageUrl, pdfName } = props;
  const [done, setDone] = useState(!props.animate);
  const [active, setActive] = useState<number | null>(null);
  const words = report?.ocr?.words ?? [];
  const marks = useMemo(() => (report && !pdfName ? buildMarks(report.findings, words) : []), [report, pdfName, words]);
  const docId = props.docId ?? report?.id;
  const failed = report?.status === 'failed';

  const openPdf = async () => {
    if (!docId) return;
    const url = URL.createObjectURL(await apiBlob(`/v1/documents/${docId}/file`));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="grid-doc">
      <div className="sticky">
        <div className="panel">
          <Inspector
            src={imageUrl}
            ratio={pdfName ? 0.75 : undefined}
            placeholder={pdfName ? (report ? 'PDF: la vista previa con cajas solo está disponible para imágenes' : 'Analizando el PDF') : undefined}
            report={report && !failed ? (pdfName ? { ...report, findings: [], ocr: null } : report) : null}
            failed={failed ? (report?.error ?? 'error') : null}
            animate={props.animate}
            active={active}
            onActive={setActive}
            onDone={() => setDone(true)}
            label={props.heading ?? report?.filename ?? 'Documento'}
          />
          {pdfName && docId && (
            <p style={{ marginTop: 10 }}>
              <button type="button" className="btn btn-quiet btn-sm" onClick={openPdf}>
                Abrir el PDF en otra pestaña
              </button>
            </p>
          )}
        </div>
      </div>

      <div className="stack">
        {!report && (
          <div className="panel">
            <p className="muted">El informe aparece cuando termina el análisis. Puede seguir trabajando; no cierre esta pestaña.</p>
          </div>
        )}
        {failed && (
          <ErrorNote>
            El análisis falló{report?.error ? `: ${report.error}` : '.'} Puede volver a subir el archivo.
          </ErrorNote>
        )}
        {report && !failed && done && (
          <>
            <div className="panel">
              <ScoreScale score={report.score ?? 0} verdict={report.verdict} />
              {report.retake_required && (
                <p className="note note-warn" style={{ marginTop: 12 }}>
                  La imagen no permite un análisis confiable. Pida al cliente otra foto.
                </p>
              )}
              <p className="muted small" style={{ marginTop: 12 }}>
                {report.template?.label
                  ? `Comparado con la plantilla «${report.template.label}».`
                  : report.confidence_note
                    ? `Nota: ${report.confidence_note}.`
                    : null}{' '}
                {props.docId === undefined && report.id && <a href={`#/app/documentos/${report.id}`}>Abrir la ficha del documento</a>}
              </p>
              {report.explanation?.summary && <p style={{ marginTop: 12 }}>{report.explanation.summary}</p>}
            </div>

            {docId && <Review report={report} docId={docId} onReviewed={props.onReviewed} />}

            <div className="panel">
              <h2>Hallazgos</h2>
              <p className="muted small" style={{ marginBottom: 12 }}>
                Los números coinciden con las cajas de la imagen. Rojo: anomalía; ámbar: revisar; azul: dato extraído.
              </p>
              <FindingsList
                findings={report.findings}
                marks={marks}
                active={active}
                onActive={setActive}
                extra={(f) => {
                  const per = report.explanation?.per_finding?.find((p: any) => p.code === f.code)?.explanation;
                  const prior = f.code.startsWith('reuse.') ? f.evidence?.prior_document_id : null;
                  return (
                    <>
                      {per && <span className="finding-msg muted">{per}</span>}
                      {prior && (
                        <a href={`#/app/documentos/${prior}`} onClick={(e) => e.stopPropagation()}>
                          Ver el documento anterior
                        </a>
                      )}
                    </>
                  );
                }}
              />
            </div>

            <div className="panel">
              <h2>Datos extraídos</h2>
              <FieldsTable fields={report.extracted_fields} provided={report.provided_fields} />
            </div>

            {!!report.external?.length && (
              <div className="panel">
                <h2>Fuentes oficiales</h2>
                <div className="table-wrap fit">
                  <table>
                    <thead>
                      <tr>
                        <th>Fuente</th>
                        <th>Resultado</th>
                        <th>Consultado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.external.map((x, i) => {
                        const [label, tone] = SOURCE_STATUS[x.status] ?? [x.status, 'muted'];
                        return (
                          <tr key={i}>
                            <td>
                              {SOURCES[x.source] ?? x.source}
                              {x.findings?.[0] && <span className="sub">{x.findings[0].message}</span>}
                            </td>
                            <td>
                              <Badge tone={tone}>{label}</Badge>
                              {x.response != null && (
                                <details>
                                  <summary className="small">Respuesta</summary>
                                  <pre className="json">{JSON.stringify(x.response, null, 2)}</pre>
                                </details>
                              )}
                            </td>
                            <td className="nowrap">{fmtDateTime(x.checked_at)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {!!report.progress?.length && (
              <div className="panel">
                <h2>Etapas del análisis</h2>
                <ol className="timeline">
                  {report.progress.map((s, i) => {
                    const t0 = new Date(report.progress![0].at).getTime();
                    const ms = new Date(s.at).getTime() - t0;
                    const detail = stageDetail(s);
                    return (
                      <li key={i}>
                        <strong>{STAGES[s.stage] ?? s.stage}</strong>
                        {detail && <span className="muted">: {detail}</span>}
                        <time dateTime={s.at}>{i === 0 ? fmtDateTime(s.at) : `+${ms} ms`}</time>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}

          </>
        )}
      </div>
    </div>
  );
}

function Review({ report, docId, onReviewed }: { report: DocReport; docId: string; onReviewed?: () => void }) {
  const [decision, setDecision] = useState('');
  const [notes, setNotes] = useState('');
  const [sample, setSample] = useState(false);
  const [editing, setEditing] = useState(!report.review);
  const [saved, setSaved] = useState<string | null>(null);
  const act = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!decision) return;
    const body: Record<string, unknown> = { decision };
    if (notes.trim()) body.notes = notes.trim();
    if (session.user) body.analyst = session.user;
    if (decision === 'legitimo' && sample) body.add_to_templates = true;
    const r = await act.run(() => api(`/v1/documents/${docId}/review`, { body }));
    if (r) {
      setSaved(
        `Revisión guardada: ${REVIEWS[decision]}.${r.template_samples ? ` La biblioteca ya tiene ${r.template_samples} muestras de este emisor.` : ''}`,
      );
      setEditing(false);
      onReviewed?.();
    }
  };

  return (
    <div className="panel">
      <h2>Revisión del analista</h2>
      {saved && (
        <p className="note note-ok" role="status" style={{ marginBottom: 12 }}>
          {saved}
        </p>
      )}
      {report.review && (
        <Facts
          items={[
            ['Decisión', <Badge tone="ink" key="d">{labelOf(REVIEWS, report.review.decision)}</Badge>],
            ['Por', report.review.by.replace(/^analyst:/, '')],
            ['Fecha', fmtDateTime(report.review.at)],
            ['Notas', report.review.notes || '—'],
          ]}
        />
      )}
      {!editing ? (
        <p style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setEditing(true)}>
            Cambiar la revisión
          </button>
        </p>
      ) : (
        <form className="form" onSubmit={submit} style={{ marginTop: report.review ? 16 : 0 }}>
          <fieldset className="field">
            <legend className="field-label" style={{ marginBottom: 6 }}>
              Decisión
            </legend>
            <div className="radio-row">
              {Object.entries({ aprobado: 'Aprobar', rechazado: 'Rechazar', legitimo: 'Marcar como legítimo' }).map(([v, l]) => (
                <label key={v}>
                  <input type="radio" name="decision" value={v} checked={decision === v} onChange={() => setDecision(v)} required />
                  {l}
                </label>
              ))}
            </div>
            <span className="field-hint">
              «Legítimo» confirma que el documento es auténtico aunque tenga hallazgos; sirve para afinar el motor.
            </span>
          </fieldset>
          {decision === 'legitimo' && (
            <label className="check">
              <input type="checkbox" checked={sample} disabled={!report.can_add_to_templates} onChange={(e) => setSample(e.target.checked)} />
              Usarlo como muestra para la plantilla de este emisor
              {!report.can_add_to_templates && <span className="muted small"> (necesita tipo, emisor y texto leído por OCR)</span>}
            </label>
          )}
          <label className="field">
            <span className="field-label">Notas (opcional)</span>
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} />
          </label>
          <ErrorNote error={act.error} />
          <div>
            <button className="btn btn-primary" disabled={!decision || act.busy}>
              {act.busy ? 'Guardando…' : 'Guardar revisión'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
