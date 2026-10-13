import { Finding } from '../../engine/engine.types';
import { Tenant } from '../../tenancy/tenant';

export interface ValidationContext {
  tenant: Tenant;
  documentType: string | null;
  /** Campos impresos (los del cliente combinados con los que extrajo el motor). */
  fields: Record<string, string>;
}

/** Respuesta de una fuente oficial, guardada con fecha y hora para el informe. */
export interface ExternalCheck {
  source: string;
  status: 'ok' | 'observed' | 'not_configured' | 'error';
  checked_at: string;
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  findings: Finding[];
}

export interface ExternalValidator {
  readonly source: string;
  applies(ctx: ValidationContext): boolean;
  validate(ctx: ValidationContext): Promise<ExternalCheck>;
}

export const EXTERNAL_VALIDATORS = Symbol('EXTERNAL_VALIDATORS');

export function externalFinding(
  code: string,
  severity: Finding['severity'],
  message: string,
  evidence: Record<string, unknown> | null = null,
  confidence = 1,
): Finding {
  return { code, layer: 'external', severity, confidence, message, region: null, evidence };
}

export function notConfigured(source: string, code: string, message: string, request: Record<string, unknown>): ExternalCheck {
  return {
    source,
    status: 'not_configured',
    checked_at: new Date().toISOString(),
    request,
    response: null,
    findings: [externalFinding(code, 'info', message)],
  };
}

export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: res.status, body };
}

export const normalizeName = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-ZÑ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Secreto de un cliente: preferir `<campo>_ref`, el nombre de una variable de entorno
 * (en AWS, un secreto inyectado), para no guardar la clave en `tenants.settings`.
 */
export function secretOf(value: string | undefined, ref: string | undefined): string | undefined {
  return (ref ? process.env[ref] : undefined) || value || undefined;
}
