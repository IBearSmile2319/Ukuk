/**
 * Reloj legal del siniestro (Res. SBS 3202-2013, Reglamento de Pago de Siniestros, y Ley 29946).
 *
 * Supuestos (documentados para validar con el área legal de cada cliente):
 * - Todos los plazos se cuentan en días CALENDARIO, en hora de Lima (UTC-5, sin horario
 *   de verano). El día 1 es el día siguiente al hecho que inicia el plazo, y el plazo
 *   vence al final (23:59:59) del último día. TODO: días hábiles y feriados si la póliza lo pide.
 * - Aviso: 3 días para seguros de daños y 7 para personas desde la ocurrencia, salvo que
 *   la póliza dé más (se toma el mayor).
 * - Sin ajustador: 30 días desde la documentación completa para aprobar o rechazar;
 *   las aclaraciones solo dentro de los primeros 20. Si no hay respuesta, el siniestro
 *   queda consentido y debe pagarse dentro de los 30 días siguientes.
 * - El pedido de aclaración NO suspende el reloj (criterio conservador). TODO: confirmar.
 */

export type InsuranceLine = 'daños' | 'personas';

export const DEFAULT_NOTICE_DAYS: Record<InsuranceLine, number> = { daños: 3, personas: 7 };
export const CLARIFICATION_DAYS = 20;
export const CONSENT_DAYS = 30;
export const PAYMENT_DAYS = 30;
export const ALERT_DAYS = [20, 25, 28] as const;

export type AlertKind = 'dia_20' | 'dia_25' | 'dia_28' | 'consentido';

export interface DeadlineAlert {
  kind: AlertKind;
  dueAt: Date;
  message: string;
}

export interface DeadlineInput {
  line: InsuranceLine;
  occurredAt?: Date | null;
  firstContactAt: Date;
  policyNoticeDays?: number | null;
  docsCompleteAt?: Date | null;
  decision?: 'aprobado' | 'rechazado' | null;
  decidedAt?: Date | null;
  now: Date;
}

export interface Deadlines {
  noticeDays: number;
  noticeDeadline: Date | null;
  lateNotice: boolean;
  clockStart: Date | null;
  /** Días calendario transcurridos desde la documentación completa. */
  dayCount: number | null;
  clarificationCutoff: Date | null;
  consentDeadline: Date | null;
  paymentDeadline: Date | null;
  canRequestClarification: boolean;
  consented: boolean;
  /** Alertas ya alcanzadas (solo mientras no haya decisión). */
  alerts: DeadlineAlert[];
}

const LIMA_OFFSET_MS = 5 * 3600_000;

export function limaDate(d: Date): string {
  return new Date(d.getTime() - LIMA_OFFSET_MS).toISOString().slice(0, 10);
}

export function addCalendarDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function endOfLimaDay(date: string): Date {
  return new Date(`${date}T23:59:59.999-05:00`);
}

export function startOfLimaDay(date: string): Date {
  return new Date(`${date}T00:00:00.000-05:00`);
}

/** Vence al final del día N contado desde el día siguiente a `from`. */
export function deadlineAfter(from: Date, days: number): Date {
  return endOfLimaDay(addCalendarDays(limaDate(from), days));
}

export function calendarDaysBetween(from: Date, to: Date): number {
  return Math.round((Date.parse(limaDate(to)) - Date.parse(limaDate(from))) / 86_400_000);
}

export function noticeDays(line: InsuranceLine, policyNoticeDays?: number | null): number {
  return Math.max(DEFAULT_NOTICE_DAYS[line], policyNoticeDays ?? 0);
}

const ALERT_TEXT: Record<AlertKind, string> = {
  dia_20: 'Día 20: último día para pedir aclaraciones al asegurado.',
  dia_25: 'Día 25: quedan 5 días para aprobar o rechazar antes de que el siniestro quede consentido.',
  dia_28: 'Día 28: quedan 2 días para pronunciarse; el siniestro quedará consentido.',
  consentido: 'Plazo de 30 días vencido sin respuesta: el siniestro quedó consentido y debe pagarse en 30 días.',
};

export function computeDeadlines(i: DeadlineInput): Deadlines {
  const nDays = noticeDays(i.line, i.policyNoticeDays);
  const noticeDeadline = i.occurredAt ? deadlineAfter(i.occurredAt, nDays) : null;
  const lateNotice = !!noticeDeadline && i.firstContactAt.getTime() > noticeDeadline.getTime();

  const start = i.docsCompleteAt ?? null;
  if (!start) {
    return {
      noticeDays: nDays,
      noticeDeadline,
      lateNotice,
      clockStart: null,
      dayCount: null,
      clarificationCutoff: null,
      consentDeadline: null,
      paymentDeadline: i.decision === 'aprobado' && i.decidedAt ? deadlineAfter(i.decidedAt, PAYMENT_DAYS) : null,
      canRequestClarification: true,
      consented: false,
      alerts: [],
    };
  }

  const clarificationCutoff = deadlineAfter(start, CLARIFICATION_DAYS);
  const consentDeadline = deadlineAfter(start, CONSENT_DAYS);
  // Una decisión tomada después del plazo no evita el consentimiento.
  const decidedInTime = !!i.decision && !!i.decidedAt && i.decidedAt.getTime() <= consentDeadline.getTime();
  const consented = !decidedInTime && i.now.getTime() > consentDeadline.getTime();
  let paymentDeadline: Date | null = null;
  if (consented) paymentDeadline = deadlineAfter(consentDeadline, PAYMENT_DAYS);
  else if (i.decision === 'aprobado' && i.decidedAt) paymentDeadline = deadlineAfter(i.decidedAt, PAYMENT_DAYS);

  const alerts: DeadlineAlert[] = [];
  if (!decidedInTime) {
    for (const d of ALERT_DAYS) {
      const dueAt = startOfLimaDay(addCalendarDays(limaDate(start), d));
      if (i.now.getTime() >= dueAt.getTime()) alerts.push({ kind: `dia_${d}` as AlertKind, dueAt, message: ALERT_TEXT[`dia_${d}` as AlertKind] });
    }
    if (consented) alerts.push({ kind: 'consentido', dueAt: consentDeadline, message: ALERT_TEXT.consentido });
  }

  return {
    noticeDays: nDays,
    noticeDeadline,
    lateNotice,
    clockStart: start,
    dayCount: calendarDaysBetween(start, i.now),
    clarificationCutoff,
    consentDeadline,
    paymentDeadline,
    canRequestClarification: i.now.getTime() <= clarificationCutoff.getTime(),
    consented,
    alerts,
  };
}
