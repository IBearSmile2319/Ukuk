import { Injectable } from '@nestjs/common';
import {
  ExternalCheck,
  ExternalValidator,
  ValidationContext,
  externalFinding,
  fetchJson,
  notConfigured,
} from './external-validator';

/** Credenciales del cliente para la API de consulta de comprobantes (tenant.settings.sunat). */
export interface SunatSettings {
  client_id: string;
  client_secret: string;
  /** RUC con el que se consulta; por defecto, el del cliente. */
  ruc?: string;
  token_url?: string;
  api_url?: string;
}

export interface SunatQuery {
  numRuc: string;
  codComp: string;
  numeroSerie: string;
  numero: string;
  fechaEmision: string; // dd/mm/yyyy
  monto?: string;
}

const COD_COMP: Record<string, string> = { factura: '01', boleta_venta: '03', recibo_honorarios: 'R1' };

/** Arma la consulta a partir de los campos impresos; null si faltan datos. */
export function buildSunatQuery(fields: Record<string, string>, documentType: string | null): SunatQuery | null {
  const ruc = fields.ruc_emisor;
  const m = /^([A-Z0-9]{4})-0*(\d{1,8})$/i.exec(fields.serie_numero ?? '');
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(fields.fecha_emision ?? '');
  if (!ruc || !/^\d{11}$/.test(ruc) || !m || !d) return null;
  const serie = m[1].toUpperCase();
  const codComp =
    (documentType && COD_COMP[documentType]) || (serie.startsWith('F') ? '01' : serie.startsWith('B') ? '03' : null);
  if (!codComp) return null;
  return {
    numRuc: ruc,
    codComp,
    numeroSerie: serie,
    numero: m[2],
    fechaEmision: `${d[3]}/${d[2]}/${d[1]}`,
    ...(fields.total ? { monto: fields.total } : {}),
  };
}

const CPE_STATE: Record<string, string> = {
  '0': 'NO EXISTE',
  '1': 'ACEPTADO',
  '2': 'ANULADO',
  '3': 'AUTORIZADO',
  '4': 'NO AUTORIZADO',
};

/**
 * Consulta integrada de comprobantes de pago de SUNAT (OAuth client_credentials con
 * las credenciales del propio cliente, generadas en el menú SOL).
 */
@Injectable()
export class SunatCpeValidator implements ExternalValidator {
  readonly source = 'sunat_cpe';

  applies(ctx: ValidationContext): boolean {
    return (
      ['factura', 'boleta_venta'].includes(ctx.documentType ?? '') || (!!ctx.fields.ruc_emisor && !!ctx.fields.serie_numero)
    );
  }

  async validate(ctx: ValidationContext): Promise<ExternalCheck> {
    const query = buildSunatQuery(ctx.fields, ctx.documentType);
    const request = query ? { ...query } : { motivo: 'faltan RUC emisor, serie-número o fecha de emisión' };
    const s = ctx.tenant.settings.sunat as SunatSettings | undefined;
    const ruc = s?.ruc ?? ctx.tenant.ruc;
    if (!s?.client_id || !s?.client_secret || !ruc) {
      return notConfigured(
        this.source,
        'external.sunat_not_configured',
        'No se consultó SUNAT: el cliente no registró sus credenciales de la API de consulta de comprobantes.',
        request,
      );
    }
    const checked_at = new Date().toISOString();
    if (!query) {
      return {
        source: this.source,
        status: 'observed',
        checked_at,
        request,
        response: null,
        findings: [externalFinding('external.sunat_incomplete', 'info', 'No se pudo consultar SUNAT: faltan datos del comprobante.')],
      };
    }

    const tokenUrl =
      s.token_url ?? `https://api-seguridad.sunat.gob.pe/v1/clientesextranet/${encodeURIComponent(s.client_id)}/oauth2/token/`;
    const token = await fetchJson(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'https://api.sunat.gob.pe/v1/contribuyente/contribuyentes',
        client_id: s.client_id,
        client_secret: s.client_secret,
      }),
    });
    if (token.status !== 200 || !token.body?.access_token) {
      throw new Error(`SUNAT no entregó token (HTTP ${token.status})`);
    }
    const apiUrl = s.api_url ?? 'https://api.sunat.gob.pe/v1/contribuyente/contribuyentes';
    const res = await fetchJson(`${apiUrl}/${ruc}/validarcomprobante`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.body.access_token}` },
      body: JSON.stringify(query),
    });
    if (res.status !== 200 || !res.body?.success) {
      throw new Error(`SUNAT respondió HTTP ${res.status}: ${res.body?.message ?? 'sin mensaje'}`);
    }
    const data = res.body.data ?? {};
    const findings = [];
    const estado = String(data.estadoCp ?? '');
    if (estado === '0') {
      findings.push(externalFinding('external.sunat_cpe_not_found', 'critical', 'El comprobante no existe en SUNAT.', { estadoCp: estado }));
    } else if (estado === '2') {
      findings.push(externalFinding('external.sunat_cpe_voided', 'critical', 'El comprobante figura como anulado en SUNAT.', { estadoCp: estado }));
    } else if (estado === '4') {
      findings.push(externalFinding('external.sunat_cpe_not_authorized', 'high', 'El comprobante figura como no autorizado en SUNAT.', { estadoCp: estado }));
    }
    if (data.estadoRuc && data.estadoRuc !== '00') {
      findings.push(
        externalFinding('external.sunat_ruc_inactive', 'high', 'El RUC del emisor no está activo en SUNAT.', {
          estadoRuc: data.estadoRuc,
        }),
      );
    }
    return {
      source: this.source,
      status: findings.length ? 'observed' : 'ok',
      checked_at,
      request,
      response: {
        estado_cp: estado,
        estado_cp_texto: CPE_STATE[estado] ?? 'DESCONOCIDO',
        estado_ruc: data.estadoRuc ?? null,
        condicion_domicilio: data.condDomiRuc ?? null,
        observaciones: data.observaciones ?? [],
      },
      findings,
    };
  }
}
