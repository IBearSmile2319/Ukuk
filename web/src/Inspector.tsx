import { useEffect, useMemo, useRef, useState } from 'react';
import type { Box, Finding, OcrWord, Stage } from './api';
import { StepProgress, useMotionPref, type MotionPref } from './ui';

/**
 * Inspector araña: recorre el documento mientras se analiza. Cada pata se apoya en una
 * palabra que encontró el OCR; a su paso deja cajas azules sobre los datos extraídos y
 * rojas (o ámbar) sobre los hallazgos. Funciona como barra de progreso: mientras la API
 * no responde camina en espera; cuando llega el informe visita cada hallazgo y se retira.
 */

export interface InspectorReport {
  findings: Finding[];
  extracted_fields?: Record<string, unknown> | null;
  ocr?: { words: OcrWord[] } | null;
  progress?: Stage[];
}

type Tone = 'red' | 'amber';
export interface Mark {
  i: number;
  box: Box;
  tone: Tone;
  inferred: boolean;
  source: Box | null;
}

const W = 1000;
const STAGES = ['Archivo recibido', 'Lectura OCR', 'Motor forense', 'Fuentes oficiales', 'Puntaje'];
const LAYER_ORDER = ['quality', 'classification', 'extraction', 'consistency', 'forensics', 'template', 'external', 'reuse'];
const SEV_RANK: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** Orden único para la lista y los números sobre la imagen: por capa y luego por severidad. */
export function orderFindings(fs: Finding[]): Finding[] {
  const layer = (f: Finding) => (LAYER_ORDER.indexOf(f.layer) + 1 || 99);
  return [...fs].sort((a, b) => layer(a) - layer(b) || SEV_RANK[b.severity] - SEV_RANK[a.severity]);
}

export function toneOf(f: Finding): Tone | null {
  if (f.severity === 'low') return 'amber';
  return SEV_RANK[f.severity] >= 2 ? 'red' : null;
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}<]+|[^\p{L}\p{N}<]+$/gu, '');

const pageOne = (words: OcrWord[] | undefined) => (words ?? []).filter((w) => !w.page || w.page === 1);

/** Palabras del OCR que contienen un valor extraído (cajas azules). */
function extractedWords(words: OcrWord[], fields: Record<string, unknown> | null | undefined): number[] {
  const wanted = new Set<string>();
  for (const v of Object.values(fields ?? {})) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    const s = String(v);
    wanted.add(norm(s));
    for (const t of s.split(/\s+/)) if (t.length >= 3) wanted.add(norm(t));
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (iso) {
      wanted.add(`${iso[3]}/${iso[2]}/${iso[1]}`);
      wanted.add(iso[1]);
    }
  }
  wanted.delete('');
  return words.flatMap((w, i) => (wanted.has(norm(w.text)) ? [i] : []));
}

const union = (bs: Box[]): Box => {
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
};
const pad = (b: Box, p: number): Box => {
  const x = Math.max(0, b.x - p);
  const y = Math.max(0, b.y - p);
  return { x, y, w: Math.min(1, b.x + b.w + p) - x, h: Math.min(1, b.y + b.h + p) - y };
};

/**
 * Hallazgos sin región (p. ej. "el total no cuadra"): se ubican buscando en el OCR el
 * valor que cita la evidencia. Se dibujan punteados para indicar que la ubicación es inferida.
 */
function inferBox(f: Finding, words: OcrWord[]): Box | null {
  const ev = f.evidence;
  if (!ev || typeof ev !== 'object') return null;
  const cand = ['printed', 'total', 'value', 'found'].map((k) => ev[k]).find((v) => v !== undefined && v !== null);
  if (cand === undefined) return null;
  const num = typeof cand === 'number' ? cand : null;
  const hits = words.filter((w) => {
    if (num !== null) {
      const n = Number(w.text.replace(/[^\d.]/g, ''));
      return /\d/.test(w.text) && n === num;
    }
    return norm(w.text) === norm(String(cand));
  });
  return hits.length ? pad(union(hits.map((w) => w.bbox)), 0.008) : null;
}

export function buildMarks(findings: Finding[], words: OcrWord[]): Mark[] {
  return findings.flatMap((f, i) => {
    const tone = toneOf(f);
    if (!tone) return [];
    const region = f.region && (!f.region.page || f.region.page === 1) ? f.region : null;
    const box = region ?? inferBox(f, words);
    if (!box) return [];
    const src = f.evidence?.source_region;
    return [{ i, box, tone, inferred: !region, source: src && typeof src.x === 'number' ? src : null }];
  });
}

// ---------------------------------------------------------------- caminante

interface P {
  x: number;
  y: number;
}
interface Waypoint extends P {
  event?: () => void;
  pause?: number;
}
interface Leg {
  side: 1 | -1;
  angle: number;
  group: 0 | 1;
  foot: P;
  from: P;
  to: P;
  t: number; // progreso del paso; -1 = apoyada
}

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: P, b: P, t: number): P => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const ease = (t: number) => t * t * (3 - 2 * t);

class Walker {
  pos: P;
  heading = 0;
  legs: Leg[] = [];
  path: Waypoint[] = [];
  seg = 0;
  speed = 0.3;
  pauseLeft = 0;
  loop = false;
  arrived = false;

  constructor(
    start: P,
    public bodyR: number,
    public reach: number,
    public anchors: P[],
  ) {
    this.pos = { ...start };
    const angles = [55, 20, -15, -50].map((a) => (a * Math.PI) / 180);
    for (const side of [-1, 1] as const)
      angles.forEach((angle, j) => {
        const foot = this.home(side, angle);
        this.legs.push({ side, angle, group: ((j + (side === 1 ? 1 : 0)) % 2) as 0 | 1, foot, from: foot, to: foot, t: -1 });
      });
  }

  setPath(points: Waypoint[], durationMs: number | null, loop = false) {
    this.path = [{ x: this.pos.x, y: this.pos.y }, ...points];
    this.seg = 0;
    this.loop = loop;
    this.arrived = false;
    if (durationMs !== null) {
      let len = 0;
      for (let k = 1; k < this.path.length; k++) len += dist(this.path[k - 1], this.path[k]);
      const pauses = points.reduce((s, p) => s + (p.pause ?? 0), 0);
      this.speed = len / Math.max(400, durationMs - pauses);
    }
  }

  private rotate(dx: number, dy: number): P {
    const c = Math.cos(this.heading);
    const s = Math.sin(this.heading);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }

  home(side: number, angle: number): P {
    const r = this.rotate(this.bodyR * 0.55 + Math.sin(angle) * this.reach * 0.9, side * Math.cos(angle) * this.reach * 0.9);
    return { x: this.pos.x + r.x, y: this.pos.y + r.y };
  }

  hip(leg: Leg): P {
    const r = this.rotate(this.bodyR * 0.55 + Math.sin(leg.angle) * this.bodyR * 0.3, leg.side * Math.cos(leg.angle) * this.bodyR * 0.5);
    return { x: this.pos.x + r.x, y: this.pos.y + r.y };
  }

  private anchorNear(p: P): P {
    let best: P | null = null;
    let bd = this.reach * 0.55;
    for (const a of this.anchors) {
      const d = dist(a, p);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best ?? p;
  }

  update(dt: number) {
    // Avance por la ruta.
    if (this.pauseLeft > 0) this.pauseLeft -= dt;
    else if (!this.arrived) {
      let budget = this.speed * dt;
      while (budget > 0 && !this.arrived) {
        const target = this.path[this.seg + 1];
        if (!target) {
          if (this.loop && this.path.length > 2) {
            this.path = [...this.path].reverse();
            this.seg = 0;
            continue;
          }
          this.arrived = true;
          break;
        }
        const d = dist(this.pos, target);
        if (d > 0.01) {
          const want = Math.atan2(target.y - this.pos.y, target.x - this.pos.x);
          let diff = want - this.heading;
          while (diff > Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          this.heading += diff * Math.min(1, dt / 140);
        }
        if (d <= budget) {
          this.pos = { x: target.x, y: target.y };
          budget -= d;
          this.seg++;
          target.event?.();
          if (target.pause) {
            this.pauseLeft = target.pause;
            break;
          }
        } else {
          this.pos = lerp(this.pos, target, budget / d);
          budget = 0;
        }
      }
    }
    // Patas: marcha alterna. Una pata da un paso cuando queda lejos de su posición natural;
    // si queda demasiado lejos, lo da aunque le toque a la otra mitad.
    const moving = this.arrived || this.pauseLeft > 0 ? 0 : this.speed;
    const stepMs = Math.max(55, Math.min(130, (this.reach * 0.3) / Math.max(moving, 0.05)));
    for (const leg of this.legs) {
      if (leg.t < 0) continue;
      leg.t = Math.min(1, leg.t + dt / stepMs);
      const p = lerp(leg.from, leg.to, ease(leg.t));
      const lift = Math.sin(Math.PI * leg.t) * this.reach * 0.1;
      const hip = this.hip(leg);
      const dx = p.x - hip.x;
      const dy = p.y - hip.y;
      const n = Math.hypot(dx, dy) || 1;
      leg.foot = { x: p.x - (dx / n) * lift, y: p.y - (dy / n) * lift };
      if (leg.t >= 1) {
        leg.foot = leg.to;
        leg.t = -1;
      }
    }
    const busy = (g: number) => this.legs.some((l) => l.group === g && l.t >= 0);
    const ahead = this.rotate(this.reach * 0.35, 0);
    for (const leg of this.legs) {
      if (leg.t >= 0) continue;
      const home = this.home(leg.side, leg.angle);
      const d = dist(leg.foot, home);
      const urgent = d > this.reach * 1.05;
      if (urgent || (d > this.reach * 0.45 && !busy(1 - leg.group))) {
        leg.from = leg.foot;
        leg.to = this.anchorNear(moving ? { x: home.x + ahead.x, y: home.y + ahead.y } : home);
        leg.t = 0;
      }
    }
  }

  legPath(leg: Leg): string {
    const hip = this.hip(leg);
    const foot = leg.foot;
    const seg = this.reach * 0.72;
    let d = dist(hip, foot);
    d = Math.min(d, seg * 2 - 0.5);
    const mid = lerp(hip, foot, 0.5);
    const h = Math.sqrt(Math.max(0, seg * seg - (d / 2) * (d / 2)));
    const dx = foot.x - hip.x;
    const dy = foot.y - hip.y;
    const n = Math.hypot(dx, dy) || 1;
    let px = -dy / n;
    let py = dx / n;
    // La rodilla se dobla hacia afuera del cuerpo.
    if ((mid.x + px - this.pos.x) ** 2 + (mid.y + py - this.pos.y) ** 2 < (mid.x - this.pos.x) ** 2 + (mid.y - this.pos.y) ** 2) {
      px = -px;
      py = -py;
    }
    const knee = { x: mid.x + px * h, y: mid.y + py * h };
    return `M${hip.x.toFixed(1)} ${hip.y.toFixed(1)}L${knee.x.toFixed(1)} ${knee.y.toFixed(1)}L${foot.x.toFixed(1)} ${foot.y.toFixed(1)}`;
  }
}

// ---------------------------------------------------------------- componente

function effectiveMode(pref: MotionPref, reduced: boolean): MotionPref {
  return reduced ? 'off' : pref;
}

const serpentine = (H: number, rows = 4): P[] =>
  Array.from({ length: rows }, (_, r) => {
    const y = H * (0.14 + (0.72 * r) / Math.max(1, rows - 1));
    return r % 2 ? [{ x: W * 0.86, y }, { x: W * 0.14, y }] : [{ x: W * 0.14, y }, { x: W * 0.86, y }];
  }).flat();

const lattice = (H: number): P[] => {
  const out: P[] = [];
  for (let x = 0.05; x < 1; x += 0.075) for (let y = 0.05; y < 1; y += 0.075 * (W / H)) out.push({ x: x * W, y: y * H });
  return out;
};

export function Inspector(props: {
  src: string | null;
  ratio?: number;
  report: InspectorReport | null;
  animate: boolean;
  active?: number | null;
  onActive?: (i: number | null) => void;
  onDone?: () => void;
  label: string;
  placeholder?: string;
  failed?: string | null;
  /** false oculta el selector de animación (p. ej. en la portada). */
  tools?: boolean;
}) {
  const { report, animate, active = null, onActive } = props;
  const [pref, setPref, reduced] = useMotionPref();
  const mode = animate ? effectiveMode(pref, reduced) : 'off';
  const [natural, setNatural] = useState<number | null>(null);
  const ratio = natural ?? props.ratio ?? 1.414;
  const H = W * ratio;

  const words = useMemo(() => pageOne(report?.ocr?.words), [report]);
  const blue = useMemo(() => extractedWords(words, report?.extracted_fields), [words, report]);
  const marks = useMemo(() => buildMarks(report?.findings ?? [], words), [report, words]);

  const [shownWords, setShownWords] = useState<Set<number>>(new Set());
  const [shownMarks, setShownMarks] = useState<Set<number>>(new Set());
  const [stage, setStage] = useState(report ? 0 : 1);
  const [running, setRunning] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [spiderGone, setSpiderGone] = useState(false);
  const [spiderLeaving, setSpiderLeaving] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1.6); // unidades del viewBox por píxel en pantalla
  const bodyRef = useRef<SVGGElement>(null);
  const legRefs = useRef<(SVGPathElement | null)[]>([]);
  const walker = useRef<Walker | null>(null);
  const startedAt = useRef(performance.now());
  const doneRef = useRef(false);
  const scaleRef = useRef(scale);
  const onDone = useRef(props.onDone);
  onDone.current = props.onDone;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.clientWidth && setScale(W / el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setShownWords(new Set(blue));
    setShownMarks(new Set(marks.map((m) => m.i)));
    setStage(STAGES.length);
    setRunning(false);
    setSpiderGone(true);
    onDone.current?.();
  };

  // Sin animación (preferencia, movimiento reducido o salto): estado final de inmediato.
  useEffect(() => {
    if (!report) {
      setStage(1);
      return;
    }
    if (mode === 'off' || skipped) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, mode, skipped, blue, marks]);

  // Modo compacto: sin araña, las cajas aparecen en secuencia rápida.
  useEffect(() => {
    if (mode !== 'compact' || !report || skipped) return;
    setRunning(true);
    setSpiderGone(true);
    const timers = [
      window.setTimeout(() => {
        setShownWords(new Set(blue));
        setStage(2);
      }, 120),
      ...marks.map((m, k) => window.setTimeout(() => setShownMarks((s) => new Set(s).add(m.i)), 200 + k * 70)),
      window.setTimeout(finish, 260 + marks.length * 70),
    ];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, report, skipped]);

  // Modo completo: la araña camina (en espera mientras no hay informe).
  useEffect(() => {
    if (mode !== 'full' || skipped || doneRef.current) return;
    if (props.failed) {
      setSpiderGone(true);
      setRunning(false);
      return;
    }
    if (props.src && natural === null) return; // esperar el tamaño real de la imagen
    const bodyR = Math.max(W * 0.019, 9 * scaleRef.current);
    const reach = bodyR * 2.9;
    const anchors = words.length ? words.map((w) => ({ x: (w.bbox.x + w.bbox.w / 2) * W, y: (w.bbox.y + w.bbox.h / 2) * H })) : lattice(H);
    if (!walker.current) {
      walker.current = new Walker({ x: W * 0.08, y: H * 0.06 }, bodyR, reach, anchors);
      startedAt.current = performance.now();
    }
    const wk = walker.current;
    wk.bodyR = bodyR;
    wk.reach = reach;
    wk.anchors = anchors;
    setSpiderGone(false);
    setRunning(true);

    if (!report) {
      wk.setPath(serpentine(H), null, true);
      wk.speed = W * 0.00026;
    } else {
      const center = (b: Box): P => ({ x: (b.x + b.w / 2) * W, y: (b.y + b.h / 2) * H });
      const order = [...blue].sort((a, b) => {
        const la = Math.round((words[a].bbox.y * H) / 40);
        const lb = Math.round((words[b].bbox.y * H) / 40);
        return la - lb || words[a].bbox.x - words[b].bbox.x;
      });
      const groups: number[][] = [];
      const per = Math.max(1, Math.ceil(order.length / 10));
      for (let k = 0; k < order.length; k += per) groups.push(order.slice(k, k + per));
      // Etapas visibles: OCR mientras marca datos, motor mientras marca hallazgos, luego fuentes y puntaje.
      setStage(1);
      const wordPts: Waypoint[] = groups.length
        ? groups.map((g) => ({
            ...center(union(g.map((i) => words[i].bbox))),
            event: () => {
              setShownWords((s) => new Set([...s, ...g]));
              if (g === groups[groups.length - 1]) setStage(2);
            },
          }))
        : (words.length ? words.filter((_, k) => k % Math.max(1, Math.floor(words.length / 8)) === 0).map((w) => center(w.bbox)) : serpentine(H, 3)).slice(0, 9);
      const markPts: Waypoint[] = [...marks]
        .sort((a, b) => a.box.y - b.box.y)
        .map((m) => ({
          ...center(m.box),
          pause: 170,
          event: () => {
            setShownMarks((s) => new Set(s).add(m.i));
          },
        }));
      const lastPt = markPts[markPts.length - 1] ?? wordPts[wordPts.length - 1];
      if (lastPt) {
        const prev = lastPt.event;
        lastPt.event = () => {
          prev?.();
          setStage(3);
        };
      }
      const exit: Waypoint = {
        x: W * 0.93,
        y: H * 0.95,
        event: () => {
          setStage(4);
          setSpiderLeaving(true);
          window.setTimeout(finish, 320);
        },
      };
      const elapsed = performance.now() - startedAt.current;
      const duration = Math.min(4000, Math.max(2200, 4800 - elapsed));
      wk.setPath([...wordPts, ...markPts, exit], duration);
    }

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      wk.update(dt);
      const body = bodyRef.current;
      if (body) {
        body.setAttribute(
          'transform',
          `translate(${wk.pos.x.toFixed(1)} ${wk.pos.y.toFixed(1)}) rotate(${((wk.heading * 180) / Math.PI).toFixed(1)}) scale(${(wk.bodyR / 10).toFixed(3)})`,
        );
      }
      wk.legs.forEach((leg, k) => legRefs.current[k]?.setAttribute('d', wk.legPath(leg)));
      if (!wk.arrived || wk.loop) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, report, skipped, natural, props.failed]);

  // Si cambia el ancho en pantalla, la araña conserva su tamaño visual.
  useEffect(() => {
    scaleRef.current = scale;
    const wk = walker.current;
    if (wk) {
      wk.bodyR = Math.max(W * 0.019, 9 * scale);
      wk.reach = wk.bodyR * 2.9;
    }
  }, [scale]);

  const k = scale; // px → unidades
  const sw = 2 * k;
  const label = !report
    ? props.failed
      ? 'El análisis no terminó'
      : 'Analizando el documento'
    : stage >= STAGES.length
      ? !props.src
        ? 'Análisis terminado'
        : `Análisis terminado: ${marks.length} ${marks.length === 1 ? 'hallazgo marcado' : 'hallazgos marcados'} sobre la imagen`
      : STAGES[Math.min(stage, STAGES.length - 1)];

  const activeMark = marks.find((m) => m.i === active) ?? null;

  return (
    <figure className="ins">
      <div className="ins-stage" ref={wrapRef} style={{ aspectRatio: `${1} / ${ratio}` }}>
        {props.src ? (
          <img
            src={props.src}
            alt=""
            onLoad={(e) => setNatural(e.currentTarget.naturalHeight / e.currentTarget.naturalWidth)}
            draggable={false}
          />
        ) : (
          <div className="ins-sheet">{props.placeholder && <span>{props.placeholder}</span>}</div>
        )}
        <svg
          viewBox={`0 0 ${W} ${H.toFixed(1)}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${props.label}. ${label}.`}
        >
          {[...shownWords].map((i) => {
            const b = words[i]?.bbox;
            if (!b) return null;
            const p = 0.004;
            return (
              <rect
                key={`w${i}`}
                className={`ins-box ins-blue${activeMark ? ' is-dim' : ''}`}
                x={(b.x - p) * W}
                y={(b.y - p) * H}
                width={(b.w + 2 * p) * W}
                height={(b.h + 2 * p) * H}
                strokeWidth={sw * 0.8}
                rx={2 * k}
              />
            );
          })}
          {activeMark?.source && (
            <g className={`ins-source ins-source-${activeMark.tone}`}>
              <rect
                x={activeMark.source.x * W}
                y={activeMark.source.y * H}
                width={activeMark.source.w * W}
                height={activeMark.source.h * H}
                strokeWidth={sw}
                strokeDasharray={`${5 * k} ${4 * k}`}
              />
              <line
                x1={(activeMark.source.x + activeMark.source.w / 2) * W}
                y1={(activeMark.source.y + activeMark.source.h / 2) * H}
                x2={(activeMark.box.x + activeMark.box.w / 2) * W}
                y2={(activeMark.box.y + activeMark.box.h / 2) * H}
                strokeWidth={sw * 0.75}
                strokeDasharray={`${3 * k} ${3 * k}`}
              />
            </g>
          )}
          {marks
            .filter((m) => shownMarks.has(m.i))
            // Las cajas pequeñas van encima de las grandes para poder elegirlas; la activa, al frente.
            .sort((a, b) => (a.i === active ? 1 : b.i === active ? -1 : b.box.w * b.box.h - a.box.w * a.box.h))
            .map((m) => {
              const isActive = m.i === active;
              const x = m.box.x * W;
              const y = m.box.y * H;
              const tag = 17 * k;
              const tagW = (String(m.i + 1).length * 8 + 10) * k;
              const bh = m.box.h * H;
              // Cajas bajas: la etiqueta va a la izquierda para no tapar la línea de arriba.
              const left = bh < tag * 1.8 && x - tagW - 3 * k >= 0;
              const tx = left ? x - tagW - 3 * k : x;
              const ty = left ? y + bh / 2 - tag / 2 : y - tag - 2 * k < 0 ? y + 2 * k : y - tag - 2 * k;
              return (
                <g
                  key={`m${m.i}`}
                  className={`ins-mark ins-${m.tone}${isActive ? ' is-active' : ''}${activeMark && !isActive ? ' is-dim' : ''}`}
                  role="button"
                  tabIndex={onActive ? 0 : -1}
                  aria-label={`Hallazgo ${m.i + 1}${m.inferred ? ' (ubicación inferida)' : ''}`}
                  aria-pressed={isActive}
                  onClick={() => onActive?.(isActive ? null : m.i)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onActive?.(isActive ? null : m.i);
                    }
                  }}
                >
                  <rect
                    x={x}
                    y={y}
                    width={m.box.w * W}
                    height={m.box.h * H}
                    rx={3 * k}
                    strokeWidth={sw * (isActive ? 1.7 : 1.15)}
                    strokeDasharray={m.inferred ? `${6 * k} ${4 * k}` : undefined}
                  />
                  <rect className="ins-tag" x={tx} y={ty} width={tagW} height={tag} rx={3 * k} />
                  <text x={tx + tagW / 2} y={ty + tag * 0.72} fontSize={12 * k} textAnchor="middle">
                    {m.i + 1}
                  </text>
                </g>
              );
            })}
          {mode === 'full' && !spiderGone && (
            <g className={`ins-spider${spiderLeaving ? ' is-leaving' : ''}`} aria-hidden="true">
              {Array.from({ length: 8 }, (_, i) => (
                <path key={i} ref={(el) => void (legRefs.current[i] = el)} strokeWidth={Math.max(2.2 * k, 3)} />
              ))}
              <g ref={bodyRef} transform={`translate(${W * 0.08} ${H * 0.06})`}>
                <ellipse cx="-11" cy="0" rx="12.5" ry="9.5" className="sp-ink sp-body" />
                <path d="M-19 3 V1 H-16 V-1 H-13 V-3 H-9 V-1 H-6 V1 H-3 V3 Z" className="sp-red" />
                <circle cx="5.5" cy="0" r="7" className="sp-ink sp-body" />
                <circle cx="8" cy="-3" r="2.6" className="sp-cream" />
                <circle cx="8" cy="3" r="2.6" className="sp-cream" />
                <circle cx="8.7" cy="-3" r="1.1" className="sp-ink" />
                <circle cx="8.7" cy="3" r="1.1" className="sp-ink" />
              </g>
            </g>
          )}
        </svg>
      </div>
      <figcaption className="ins-bar">
        <StepProgress done={report ? stage : 1} total={STAGES.length} busy={!report && !props.failed} />
        <span className="ins-status" aria-live="polite">
          {label}
        </span>
        <span className="ins-tools">
          {running && mode !== 'off' && (
            <button type="button" className="btn-link" onClick={() => setSkipped(true)}>
              Saltar animación
            </button>
          )}
          {props.tools !== false && (
          <label className="ins-pref">
            <span className="sr-only">Animación del análisis</span>
            <select
              value={reduced ? 'off' : pref}
              disabled={reduced}
              title={reduced ? 'Su sistema pide reducir el movimiento' : 'Animación del análisis'}
              onChange={(e) => setPref(e.target.value as MotionPref)}
            >
              <option value="full">Animación completa</option>
              <option value="compact">Animación compacta</option>
              <option value="off">Sin animación</option>
            </select>
          </label>
          )}
        </span>
      </figcaption>
    </figure>
  );
}
