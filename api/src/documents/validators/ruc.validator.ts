import { Injectable } from '@nestjs/common';
import { EngineClient } from '../../engine/engine.client';
import { Finding } from '../../engine/engine.types';
import { ExternalCheck, ExternalValidator, ValidationContext } from './external-validator';

/** Dígito de control y tipo de contribuyente del RUC, con la regla del motor. */
@Injectable()
export class RucValidator implements ExternalValidator {
  readonly source = 'ruc';

  constructor(private readonly engine: EngineClient) {}

  applies(ctx: ValidationContext): boolean {
    return !!ctx.fields.ruc_emisor;
  }

  async validate(ctx: ValidationContext): Promise<ExternalCheck> {
    const ruc = ctx.fields.ruc_emisor;
    const res = await this.engine.validateRuc(ruc);
    const findings: Finding[] = res.valid
      ? []
      : [
          {
            code: 'ruc.invalid',
            layer: 'consistency',
            severity: 'high',
            confidence: 0.95,
            message: `El RUC del emisor ${ruc} no es válido (dígito de control o prefijo).`,
            region: null,
            evidence: { ruc },
          },
        ];
    return {
      source: this.source,
      status: res.valid ? 'ok' : 'observed',
      checked_at: new Date().toISOString(),
      request: { ruc },
      response: { valid: res.valid, kind: res.kind },
      findings,
    };
  }
}
