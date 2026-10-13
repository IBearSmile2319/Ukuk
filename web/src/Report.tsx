import { useEffect, useRef, type ReactNode } from 'react';
import type { Finding } from './api';
import type { Mark } from './Inspector';
import { Badge, FIELDS, LAYERS, SEVERITIES, fmtPct, labelOf, severityTone } from './ui';

/** Hallazgos agrupados por capa; cada uno lleva el mismo número que su caja en la imagen. */
export function FindingsList(props: {
  findings: Finding[];
  marks: Mark[];
  active: number | null;
  onActive: (i: number | null) => void;
  extra?: (f: Finding) => ReactNode;
}) {
  const { findings, marks, active, onActive } = props;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (active !== null) refs.current[active]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active]);
  if (!findings.length) return <p className="muted">Sin hallazgos.</p>;
  const groups: { layer: string; items: number[] }[] = [];
  findings.forEach((f, i) => {
    const g = groups.find((x) => x.layer === f.layer);
    if (g) g.items.push(i);
    else groups.push({ layer: f.layer, items: [i] });
  });
  return (
    <div className="findings">
      {groups.map((g) => (
        <section key={g.layer}>
          <h4>{labelOf(LAYERS, g.layer)}</h4>
          <ol>
            {g.items.map((i) => {
              const f = findings[i];
              const mark = marks.find((m) => m.i === i);
              return (
                <li key={i}>
                  <button
                    type="button"
                    ref={(el) => void (refs.current[i] = el)}
                    className={`finding${active === i ? ' is-active' : ''}${f.severity === 'info' ? ' is-info' : ''}`}
                    aria-pressed={active === i}
                    onClick={() => onActive(active === i ? null : i)}
                  >
                    <span className={`fno fno-${mark?.tone ?? 'none'}`}>{i + 1}</span>
                    <span className="finding-body">
                      <span className="finding-msg">{f.message}</span>
                      <span className="finding-meta">
                        <Badge tone={severityTone(f.severity)}>{labelOf(SEVERITIES, f.severity)}</Badge>
                        {f.severity !== 'info' && <span>Confianza {fmtPct(f.confidence)}</span>}
                        {mark?.inferred && <span>Ubicación inferida por el valor citado</span>}
                        {!mark && f.severity !== 'info' && f.severity !== 'low' && !f.region && <span>Sin región en la imagen</span>}
                      </span>
                      {props.extra?.(f)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

export function FieldsTable({ fields, provided }: { fields: Record<string, unknown> | null | undefined; provided?: Record<string, unknown> | null }) {
  const entries = Object.entries(fields ?? {});
  if (!entries.length) return <p className="muted">No se extrajeron datos.</p>;
  return (
    <dl className="facts facts-fields">
      {entries.map(([k, v]) => {
        const p = provided?.[k];
        const differs = p !== undefined && p !== null && String(p) !== String(v);
        return (
          <div key={k}>
            <dt>{labelOf(FIELDS, k)}</dt>
            <dd className={k === 'mrz' ? 'mono' : undefined}>
              {typeof v === 'object' ? JSON.stringify(v) : String(v)}
              {differs && <span className="field-diff">Declarado: {String(p)}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
