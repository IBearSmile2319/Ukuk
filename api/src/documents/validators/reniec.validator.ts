import { Injectable } from '@nestjs/common';
import {
  ExternalCheck,
  ExternalValidator,
  ValidationContext,
  externalFinding,
  fetchJson,
  normalizeName,
  notConfigured,
} from './external-validator';

/**
 * Credenciales del convenio RENIEC del propio cliente (tenant.settings.reniec). El
 * convenio prohíbe revender datos: Ukuk nunca usa un acceso propio, y del resultado
 * solo guarda si los nombres coinciden, no los datos de la persona.
 */
export interface ReniecSettings {
  endpoint?: string;
  dni_usuario: string;
  ruc_usuario: string;
  password: string;
}

const PIDE_URL = 'https://ws5.pide.gob.pe/Rest/Reniec/Consultar';

@Injectable()
export class ReniecValidator implements ExternalValidator {
  readonly source = 'reniec';

  applies(ctx: ValidationContext): boolean {
    return ctx.documentType === 'dni' || !!ctx.fields.dni;
  }

  async validate(ctx: ValidationContext): Promise<ExternalCheck> {
    const dni = ctx.fields.dni ?? '';
    const request = { dni };
    const s = ctx.tenant.settings.reniec as ReniecSettings | undefined;
    if (!s?.dni_usuario || !s?.ruc_usuario || !s?.password) {
      return notConfigured(
        this.source,
        'external.reniec_not_configured',
        'No se consultó RENIEC: el cliente no registró las credenciales de su convenio.',
        request,
      );
    }
    const checked_at = new Date().toISOString();
    if (!/^\d{8}$/.test(dni)) {
      return {
        source: this.source,
        status: 'observed',
        checked_at,
        request,
        response: null,
        findings: [externalFinding('external.reniec_incomplete', 'info', 'No se consultó RENIEC: falta un DNI de 8 dígitos.')],
      };
    }
    const q = new URLSearchParams({
      nuDniConsulta: dni,
      nuDniUsuario: s.dni_usuario,
      nuRucUsuario: s.ruc_usuario,
      password: s.password,
      out: 'json',
    });
    const res = await fetchJson(`${s.endpoint ?? PIDE_URL}?${q}`);
    const ret = res.body?.consultarResponse?.return;
    if (res.status !== 200 || !ret) throw new Error(`RENIEC respondió HTTP ${res.status}`);

    const findings = [];
    const response: Record<string, unknown> = { co_resultado: ret.coResultado, de_resultado: ret.deResultado ?? null };
    if (ret.coResultado !== '0000') {
      findings.push(
        externalFinding('external.reniec_no_result', 'high', 'RENIEC no devolvió datos para este DNI.', {
          co_resultado: ret.coResultado,
        }),
      );
    } else {
      const p = ret.datosPersona ?? {};
      if (ctx.fields.apellidos) {
        const ok = normalizeName(`${p.apPrimer ?? ''} ${p.apSegundo ?? ''}`) === normalizeName(ctx.fields.apellidos);
        response.apellidos_coinciden = ok;
        if (!ok) findings.push(externalFinding('external.reniec_name_mismatch', 'high', 'Los apellidos impresos no coinciden con RENIEC.'));
      }
      if (ctx.fields.nombres) {
        const ok = normalizeName(p.prenombres ?? '') === normalizeName(ctx.fields.nombres);
        response.nombres_coinciden = ok;
        if (!ok) findings.push(externalFinding('external.reniec_name_mismatch', 'high', 'Los nombres impresos no coinciden con RENIEC.'));
      }
    }
    return { source: this.source, status: findings.length ? 'observed' : 'ok', checked_at, request, response, findings };
  }
}
