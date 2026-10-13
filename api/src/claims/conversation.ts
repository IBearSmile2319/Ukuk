import { ClaimTypeConfig } from './claim-config';
import { InsuranceLine, addCalendarDays, limaDate } from './deadlines';

/**
 * Máquina de estados de la conversación de WhatsApp. Pura: recibe el estado, el
 * mensaje y el contexto ya resuelto (p. ej. el resultado de buscar la póliza) y
 * devuelve el nuevo estado, los mensajes a enviar y los efectos que ejecuta el servicio.
 *
 * Cada mensaje cuesta (~US$ 0.03 desde oct-2026): textos cortos y un mensaje por paso.
 */

export type Step =
  | 'saludo'
  | 'identificacion'
  | 'eleccion_poliza'
  | 'tipo'
  | 'fecha'
  | 'ubicacion'
  | 'relato'
  | 'fotos'
  | 'documentos'
  | 'confirmacion'
  | 'registrado'
  | 'cancelado'
  | 'asesor';

export const TERMINAL_STEPS: Step[] = ['registrado', 'cancelado', 'asesor'];

export interface PolicySnapshot {
  policy_number: string;
  holder_name: string;
  holder_dni: string | null;
  plate: string | null;
  product: string | null;
  line: InsuranceLine;
  start_date: string | null;
  end_date: string | null;
  notice_days: number | null;
  status: string;
}

export interface ClaimLocation {
  lat?: number;
  lng?: number;
  address?: string;
  name?: string;
}

export interface ConversationData {
  policy?: PolicySnapshot;
  candidates?: PolicySnapshot[];
  claimType?: string;
  occurredAt?: string;
  timeKnown?: boolean;
  location?: ClaimLocation;
  narrative?: string;
  narrativeFileId?: string;
  docs: { code: string; fileId: string }[];
  pendingDocs: string[];
  docIndex: number;
  invalid: number;
}

export interface ConversationState {
  step: Step;
  data: ConversationData;
}

export type Inbound =
  | { kind: 'text'; text: string }
  | { kind: 'reply'; id: string; title: string }
  | { kind: 'location'; lat: number; lng: number; name?: string; address?: string }
  | { kind: 'media'; media: 'image' | 'video' | 'audio' | 'document'; fileId: string; mimeType: string; caption?: string }
  | { kind: 'unsupported' };

export interface StepContext {
  now: Date;
  tenantName: string;
  claimTypes: ClaimTypeConfig[];
  /** Resultado de buscar la póliza (solo en identificación, cuando el dato es válido). */
  lookup?: PolicySnapshot[];
  /** Fotos ya recibidas para este caso (captura en vivo + WhatsApp). */
  photosCount: number;
}

export interface Button {
  id: string;
  title: string;
}

export type Outbound =
  | { type: 'text'; text: string }
  | { type: 'buttons'; text: string; buttons: Button[] }
  | { type: 'list'; text: string; button: string; rows: { id: string; title: string; description?: string }[] }
  /** El servicio agrega el enlace firmado y el botón "Listo". */
  | { type: 'capture_link'; text: string };

export type Effect =
  | { type: 'ensure_draft' }
  | { type: 'submit' }
  | { type: 'cancel' }
  | { type: 'handoff'; reason: string };

export interface StepResult {
  state: ConversationState;
  out: Outbound[];
  effects: Effect[];
}

/** Marcador que el servicio reemplaza por el número de siniestro al registrarlo. */
export const CLAIM_NUMBER_TOKEN = '{numero_siniestro}';
export const MAX_INVALID = 3;

export function initialState(): ConversationState {
  return { step: 'saludo', data: { docs: [], pendingDocs: [], docIndex: 0, invalid: 0 } };
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9:/\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export type Identifier = { kind: 'dni' | 'placa' | 'poliza'; value: string };

/** DNI (8 dígitos), placa (ABC-123, A1B-234, 1234-AB) o N° de póliza. */
export function parseIdentifier(text: string): Identifier | { error: string } | null {
  const t = text.trim().toUpperCase().replace(/^(DNI|PLACA|POLIZA|PÓLIZA|N°|NRO\.?|NO\.?)\s*:?\s*/, '').replace(/\s+/g, '');
  if (/^\d+$/.test(t)) {
    if (t.length === 8) return { kind: 'dni', value: t };
    if (t.length >= 10) return { kind: 'poliza', value: t };
    return { error: 'El DNI debe tener 8 dígitos.' };
  }
  const plate = /^([A-Z0-9]{3})-?(\d{3})$/.exec(t);
  if (plate && /[A-Z]/.test(plate[1])) return { kind: 'placa', value: `${plate[1]}-${plate[2]}` };
  const moto = /^(\d{4})-?([A-Z]{2})$/.exec(t);
  if (moto) return { kind: 'placa', value: `${moto[1]}-${moto[2]}` };
  if (/^[A-Z0-9][A-Z0-9\-/]{4,29}$/.test(t) && /\d/.test(t)) return { kind: 'poliza', value: t };
  return null;
}

/**
 * Fecha y hora de ocurrencia en hora de Lima: "hoy 14:30", "ayer 9am", "12/10/2026 18:45",
 * "12/10 8 pm". Sin hora se toma el mediodía y se marca timeKnown = false.
 */
export function parseOccurrence(text: string, now: Date): { date: Date; timeKnown: boolean } | null {
  const t = norm(text);
  const today = limaDate(now);
  let day: string | null = null;
  if (/\b(anteayer|antes de ayer|antier)\b/.test(t)) day = addCalendarDays(today, -2);
  else if (/\bayer\b/.test(t)) day = addCalendarDays(today, -1);
  else if (/\b(hoy|hace un rato|recien)\b/.test(t)) day = today;
  const dm = /\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\b/.exec(t);
  let rest = t;
  if (!day && dm) {
    const d = Number(dm[1]);
    const m = Number(dm[2]);
    let y = dm[3] ? Number(dm[3]) : Number(today.slice(0, 4));
    if (y < 100) y += 2000;
    if (d < 1 || d > 31 || m < 1 || m > 12) return null;
    day = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (new Date(`${day}T00:00:00Z`).getUTCDate() !== d) return null;
    // "12/10" sin año que caería en el futuro → año anterior.
    if (!dm[3] && day > today) day = `${y - 1}${day.slice(4)}`;
    rest = t.replace(dm[0], ' ');
  }
  if (!day) return null;
  let hh: number | null = null;
  let mm = 0;
  const hm = /\b(\d{1,2})\s*(?::|h|\.)\s*(\d{2})\s*(am|pm|a m|p m)?\b/.exec(rest);
  const hOnly = /\b(\d{1,2})\s*(am|pm|a m|p m|hrs|horas)\b/.exec(rest);
  if (hm) {
    hh = Number(hm[1]);
    mm = Number(hm[2]);
    if (hm[3]?.startsWith('p') && hh < 12) hh += 12;
    if (hm[3]?.startsWith('a') && hh === 12) hh = 0;
  } else if (hOnly) {
    hh = Number(hOnly[1]);
    if (hOnly[2].startsWith('p') && hh < 12) hh += 12;
    if (hOnly[2].startsWith('a') && hh === 12) hh = 0;
  } else if (/\bmediodia\b/.test(rest)) hh = 12;
  if (hh !== null && (hh > 23 || mm > 59)) return null;
  const time = `${String(hh ?? 12).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  return { date: new Date(`${day}T${time}:00-05:00`), timeKnown: hh !== null };
}

function fmtLima(iso: string, timeKnown = true): string {
  const d = new Date(new Date(iso).getTime() - 5 * 3600_000).toISOString();
  const date = `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  return timeKnown ? `${date} ${d.slice(11, 16)}` : date;
}

const HELP: Partial<Record<Step, string>> = {
  identificacion: 'Escriba su DNI (8 dígitos), la placa (ABC-123) o su N° de póliza.',
  eleccion_poliza: 'Elija una de las pólizas de la lista.',
  tipo: 'Elija en la lista qué ocurrió.',
  fecha: 'Escriba cuándo ocurrió, por ejemplo: hoy 14:30, ayer 9 pm o 12/10/2026 18:45.',
  ubicacion: 'Envíe su ubicación (clip > Ubicación) o escriba la dirección.',
  relato: 'Cuéntenos qué pasó por texto o con una nota de voz.',
  fotos: 'Abra el enlace, tome las fotos con la cámara y luego toque LISTO.',
  documentos: 'Envíe una foto o PDF del documento pedido, o toque DESPUÉS.',
  confirmacion: 'Toque CONFIRMAR para registrar o CANCELAR para salir.',
};

const COMMANDS_HINT = 'En cualquier momento puede escribir AYUDA, ASESOR o CANCELAR.';

export function step(state: ConversationState, input: Inbound, ctx: StepContext): StepResult {
  const s: ConversationState = { step: state.step, data: { ...state.data, docs: [...state.data.docs], pendingDocs: [...state.data.pendingDocs] } };
  if (TERMINAL_STEPS.includes(s.step)) return step(initialState(), input, ctx);

  // Los id de botones/listas se comparan tal cual; el texto libre, normalizado.
  const text = input.kind === 'text' ? norm(input.text) : input.kind === 'reply' ? input.id.toLowerCase() : '';
  if (s.step !== 'saludo') {
    if (/^(cancelar|cancela|salir)$/.test(text)) {
      return { state: { ...s, step: 'cancelado' }, out: [{ type: 'text', text: 'Registro cancelado. Si necesita algo más, escríbanos.' }], effects: [{ type: 'cancel' }] };
    }
    if (/^(asesor|humano|agente|persona)$/.test(text)) return handoff(s, 'pedido_del_cliente');
    if (/^(ayuda|\?)$/.test(text)) {
      return { state: s, out: [{ type: 'text', text: `${HELP[s.step] ?? ''} ${COMMANDS_HINT}`.trim() }], effects: [] };
    }
  }

  switch (s.step) {
    case 'saludo':
      s.step = 'identificacion';
      return {
        state: s,
        out: [
          {
            type: 'text',
            text: `Hola, soy el asistente de siniestros de ${ctx.tenantName}. Para empezar, escriba su DNI, la placa del vehículo o su N° de póliza. ${COMMANDS_HINT}`,
          },
        ],
        effects: [],
      };

    case 'identificacion': {
      if (input.kind !== 'text') return invalid(s, HELP.identificacion!);
      const id = parseIdentifier(input.text);
      if (!id) return invalid(s, `No reconocí el dato. ${HELP.identificacion}`);
      if ('error' in id) return invalid(s, id.error);
      const found = ctx.lookup ?? [];
      if (!found.length) return invalid(s, `No encontramos una póliza con ${id.value}. Revise el dato o escriba ASESOR.`);
      if (found.length === 1) return askType(s, found[0], ctx);
      s.step = 'eleccion_poliza';
      s.data.candidates = found.slice(0, 10);
      return {
        state: ok(s),
        out: [
          {
            type: 'list',
            text: 'Encontramos varias pólizas. ¿Sobre cuál es el siniestro?',
            button: 'Ver pólizas',
            rows: s.data.candidates.map((p) => ({ id: `pol:${p.policy_number}`, title: p.policy_number, description: [p.product, p.plate].filter(Boolean).join(' · ') })),
          },
        ],
        effects: [],
      };
    }

    case 'eleccion_poliza': {
      const wanted = input.kind === 'reply' ? input.id.replace(/^pol:/, '') : input.kind === 'text' ? input.text.trim().toUpperCase() : '';
      const p = s.data.candidates?.find((c) => c.policy_number.toUpperCase() === wanted.toUpperCase());
      if (!p) return invalid(s, HELP.eleccion_poliza!);
      return askType(s, p, ctx);
    }

    case 'tipo': {
      const types = typesFor(s, ctx);
      const raw = input.kind === 'reply' ? input.id.replace(/^tipo:/, '') : text;
      if (raw === 'otro') return handoff(s, 'tipo_no_atendido');
      const t = types.find((x) => x.code === raw || norm(x.code) === raw || norm(x.label) === raw);
      if (!t) return invalid(s, HELP.tipo!);
      s.data.claimType = t.code;
      s.step = 'fecha';
      return { state: ok(s), out: [{ type: 'text', text: `¿Cuándo ocurrió? ${HELP.fecha!.replace('Escriba cuándo ocurrió, p', 'P')}` }], effects: [] };
    }

    case 'fecha': {
      if (input.kind !== 'text') return invalid(s, HELP.fecha!);
      const when = parseOccurrence(input.text, ctx.now);
      if (!when) return invalid(s, `No entendí la fecha. ${HELP.fecha}`);
      if (when.date.getTime() > ctx.now.getTime() + 10 * 60_000) return invalid(s, 'La fecha no puede ser futura. ' + HELP.fecha);
      s.data.occurredAt = when.date.toISOString();
      s.data.timeKnown = when.timeKnown;
      s.step = 'ubicacion';
      return { state: ok(s), out: [{ type: 'text', text: `¿Dónde ocurrió? ${HELP.ubicacion}` }], effects: [] };
    }

    case 'ubicacion': {
      if (input.kind === 'location') s.data.location = { lat: input.lat, lng: input.lng, name: input.name, address: input.address };
      else if (input.kind === 'text' && input.text.trim().length >= 6) s.data.location = { address: input.text.trim().slice(0, 300) };
      else return invalid(s, HELP.ubicacion!);
      s.step = 'relato';
      return { state: ok(s), out: [{ type: 'text', text: 'Cuéntenos brevemente qué pasó. Puede escribir o enviar una nota de voz.' }], effects: [] };
    }

    case 'relato': {
      if (input.kind === 'text' && input.text.trim().length >= 10) s.data.narrative = input.text.trim().slice(0, 4000);
      else if (input.kind === 'media' && input.media === 'audio') s.data.narrativeFileId = input.fileId;
      else return invalid(s, 'Necesitamos un poco más de detalle. Escriba qué pasó o envíe una nota de voz.');
      return afterNarrative(ok(s), ctx);
    }

    case 'fotos': {
      if (input.kind === 'media' && (input.media === 'image' || input.media === 'video')) {
        return {
          state: ok(s),
          out: [{ type: 'buttons', text: `Recibimos ${ctx.photosCount} foto(s). Las fotos del enlace tienen más validez. Toque LISTO al terminar.`, buttons: [{ id: 'fotos:listo', title: 'Listo' }] }],
          effects: [],
        };
      }
      if (text !== 'fotos:listo' && text !== 'listo') return invalid(s, HELP.fotos!);
      if (ctx.photosCount === 0) return invalid(s, 'Aún no recibimos fotos. Use el enlace o envíelas por aquí.');
      return afterPhotos(ok(s), ctx);
    }

    case 'documentos': {
      const docs = currentType(s, ctx)?.required_docs ?? [];
      const doc = docs[s.data.docIndex];
      if (!doc) return toConfirmation(s, ctx);
      if (input.kind === 'media' && (input.media === 'image' || input.media === 'document')) {
        s.data.docs.push({ code: doc.code, fileId: input.fileId });
      } else if (text === 'doc:despues' || text === 'despues') {
        s.data.pendingDocs.push(doc.code);
      } else {
        return invalid(s, `Envíe una foto o PDF de: ${doc.label}. Si no lo tiene ahora, toque DESPUÉS.`);
      }
      s.data.docIndex++;
      return askDocOrConfirm(ok(s), ctx);
    }

    case 'confirmacion': {
      if (/^(confirmar|confirmo|si|ok|correcto)$/.test(text)) {
        s.step = 'registrado';
        const pending = s.data.pendingDocs.length
          ? ' Puede enviar los documentos pendientes respondiendo a este chat.'
          : '';
        return {
          state: s,
          out: [
            {
              type: 'text',
              text: `Listo. Su siniestro quedó registrado con el número ${CLAIM_NUMBER_TOKEN}. Le avisaremos por este medio.${pending}`,
            },
          ],
          effects: [{ type: 'submit' }],
        };
      }
      return invalid(s, HELP.confirmacion!);
    }
  }
  return { state: s, out: [], effects: [] };
}

function ok(s: ConversationState): ConversationState {
  s.data.invalid = 0;
  return s;
}

function invalid(s: ConversationState, message: string): StepResult {
  s.data.invalid++;
  if (s.data.invalid >= MAX_INVALID) return handoff(s, 'intentos_fallidos');
  return { state: s, out: [{ type: 'text', text: message }], effects: [] };
}

function handoff(s: ConversationState, reason: string): StepResult {
  const text =
    reason === 'tipo_no_atendido'
      ? 'Ese tipo de siniestro lo atiende un asesor. Le escribirá por este chat en horario de atención.'
      : reason === 'intentos_fallidos'
        ? 'No logramos continuar. Un asesor le escribirá por este chat en horario de atención.'
        : 'Le derivamos con un asesor. Le escribirá por este chat en horario de atención.';
  return { state: { ...s, step: 'asesor' }, out: [{ type: 'text', text }], effects: [{ type: 'handoff', reason }] };
}

function typesFor(s: ConversationState, ctx: StepContext): ClaimTypeConfig[] {
  return ctx.claimTypes.filter((t) => !s.data.policy || t.line === s.data.policy.line);
}

function currentType(s: ConversationState, ctx: StepContext): ClaimTypeConfig | undefined {
  return ctx.claimTypes.find((t) => t.code === s.data.claimType);
}

function askType(s: ConversationState, policy: PolicySnapshot, ctx: StepContext): StepResult {
  s.data.policy = policy;
  s.data.candidates = undefined;
  const types = typesFor(s, ctx);
  if (!types.length) return handoff(s, 'tipo_no_atendido');
  s.step = 'tipo';
  return {
    state: ok(s),
    out: [
      {
        type: 'list',
        text: `Póliza ${policy.policy_number} a nombre de ${policy.holder_name}. ¿Qué ocurrió?`,
        button: 'Elegir',
        rows: [...types.slice(0, 9).map((t) => ({ id: `tipo:${t.code}`, title: t.label })), { id: 'tipo:otro', title: 'Otro' }],
      },
    ],
    effects: [],
  };
}

function afterNarrative(s: ConversationState, ctx: StepContext): StepResult {
  if (currentType(s, ctx)?.photos) {
    s.step = 'fotos';
    return {
      state: s,
      out: [{ type: 'capture_link', text: 'Tome fotos de los daños con este enlace. Usa la cámara y registra hora y ubicación; vence en 24 h. Toque LISTO al terminar.' }],
      effects: [{ type: 'ensure_draft' }],
    };
  }
  return afterPhotos(s, ctx);
}

function afterPhotos(s: ConversationState, ctx: StepContext): StepResult {
  s.step = 'documentos';
  s.data.docIndex = 0;
  return askDocOrConfirm(s, ctx);
}

function askDocOrConfirm(s: ConversationState, ctx: StepContext): StepResult {
  const doc = currentType(s, ctx)?.required_docs[s.data.docIndex];
  if (!doc) return toConfirmation(s, ctx);
  return {
    state: s,
    out: [{ type: 'buttons', text: `Envíe una foto o PDF de: ${doc.label}.`, buttons: [{ id: 'doc:despues', title: 'Después' }] }],
    effects: [{ type: 'ensure_draft' }],
  };
}

function toConfirmation(s: ConversationState, ctx: StepContext): StepResult {
  s.step = 'confirmacion';
  const d = s.data;
  const type = currentType(s, ctx);
  const loc = d.location?.address ?? d.location?.name ?? (d.location?.lat !== undefined ? `GPS ${d.location.lat.toFixed(5)}, ${d.location.lng?.toFixed(5)}` : '-');
  const docs = type?.required_docs ?? [];
  const pending = docs.filter((x) => d.pendingDocs.includes(x.code)).map((x) => x.label);
  const lines = [
    'Resumen:',
    `- Póliza: ${d.policy?.policy_number} (${d.policy?.holder_name})`,
    `- Tipo: ${type?.label ?? d.claimType}`,
    `- Fecha: ${d.occurredAt ? fmtLima(d.occurredAt, d.timeKnown) : '-'}`,
    `- Lugar: ${loc}`,
    `- Relato: ${d.narrative ? truncate(d.narrative, 120) : d.narrativeFileId ? 'nota de voz' : '-'}`,
  ];
  if (type?.photos) lines.push(`- Fotos: ${ctx.photosCount}`);
  if (docs.length) lines.push(`- Documentos: ${docs.length - pending.length} de ${docs.length}${pending.length ? ` (pendiente: ${pending.join(', ')})` : ''}`);
  lines.push('¿Registramos el siniestro?');
  return {
    state: s,
    out: [{ type: 'buttons', text: lines.join('\n'), buttons: [{ id: 'confirmar', title: 'Confirmar' }, { id: 'cancelar', title: 'Cancelar' }] }],
    effects: [{ type: 'ensure_draft' }],
  };
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
