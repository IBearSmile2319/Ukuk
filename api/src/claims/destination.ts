import { Inject, Injectable, Logger } from '@nestjs/common';
import { DestinationConfig } from './claim-config';
import { ukukSignature } from './webhook-signature';

/** Correo al ajustador. TODO: implementación con SES; por ahora solo deja constancia en el log. */
export interface ClaimMailer {
  send(to: string[], subject: string, body: string): Promise<void>;
}
export const CLAIM_MAILER = Symbol('CLAIM_MAILER');

@Injectable()
export class LoggerMailer implements ClaimMailer {
  private readonly logger = new Logger('ClaimMailer');
  async send(to: string[], subject: string, _body: string) {
    this.logger.log(`[stub] correo a ${to.join(', ')}: ${subject}`);
  }
}

export interface DispatchResult {
  channel: DestinationConfig['type'];
  ok: boolean;
  error?: string;
}

/** Envía el caso al sistema de siniestros (webhook firmado) o al correo del ajustador. */
@Injectable()
export class ClaimDispatcher {
  private readonly logger = new Logger(ClaimDispatcher.name);

  constructor(@Inject(CLAIM_MAILER) private readonly mailer: ClaimMailer) {}

  async dispatch(dest: DestinationConfig, payload: { number: string } & Record<string, unknown>): Promise<DispatchResult> {
    try {
      if (dest.type === 'webhook') {
        const body = JSON.stringify(payload);
        const ts = Math.floor(Date.now() / 1000);
        const res = await fetch(dest.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-ukuk-signature': ukukSignature(dest.secret, body, ts) },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`destino respondió ${res.status}`);
      } else if (dest.type === 'email') {
        await this.mailer.send(dest.to, `Siniestro ${payload.number}`, JSON.stringify(payload, null, 2));
      }
      return { channel: dest.type, ok: true };
    } catch (err) {
      this.logger.warn(`No se pudo enviar el siniestro ${payload.number}: ${(err as Error).message}`);
      return { channel: dest.type, ok: false, error: (err as Error).message };
    }
  }
}

/** Transcripción de notas de voz. TODO: integrar Amazon Transcribe u otro (es-PE). */
export interface Transcriber {
  transcribe(audio: Buffer, mimeType: string): Promise<string | null>;
}
export const TRANSCRIBER = Symbol('TRANSCRIBER');

export class NoopTranscriber implements Transcriber {
  async transcribe(): Promise<string | null> {
    return null;
  }
}
