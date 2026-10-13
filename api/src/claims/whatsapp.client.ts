import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { Button } from './conversation';

/** Número de WhatsApp Business de la aseguradora desde el que se envía. */
export interface WaSender {
  phoneNumberId: string;
  accessToken: string;
}

export interface WaListRow {
  id: string;
  title: string;
  description?: string;
}

export interface WhatsAppClient {
  sendText(from: WaSender, to: string, text: string): Promise<{ id: string | null }>;
  /** Botones de respuesta rápida (máx. 3). */
  sendButtons(from: WaSender, to: string, text: string, buttons: Button[]): Promise<{ id: string | null }>;
  /** Lista interactiva (máx. 10 filas). */
  sendList(from: WaSender, to: string, text: string, button: string, rows: WaListRow[]): Promise<{ id: string | null }>;
  /** Descarga inmediata: la URL que entrega Graph vence a los 5 minutos. */
  downloadMedia(from: WaSender, mediaId: string): Promise<{ data: Buffer; mimeType: string }>;
}

export const WHATSAPP_CLIENT = Symbol('WHATSAPP_CLIENT');

/** Límites de tamaño de WhatsApp por tipo de archivo. */
export const MEDIA_LIMITS: Record<string, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Cliente real de la Cloud API (Graph). */
@Injectable()
export class GraphWhatsAppClient implements WhatsAppClient {
  private readonly logger = new Logger(GraphWhatsAppClient.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private async send(from: WaSender, payload: Record<string, unknown>): Promise<{ id: string | null }> {
    const res = await fetch(`${this.config.whatsapp.graphUrl}/${encodeURIComponent(from.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${from.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
    if (!res.ok) throw new Error(`WhatsApp respondió ${res.status}: ${body.error?.message ?? 'sin detalle'}`);
    return { id: body.messages?.[0]?.id ?? null };
  }

  sendText(from: WaSender, to: string, text: string) {
    return this.send(from, { to, type: 'text', text: { body: clip(text, 4096), preview_url: true } });
  }

  sendButtons(from: WaSender, to: string, text: string, buttons: Button[]) {
    return this.send(from, {
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: clip(text, 1024) },
        action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: clip(b.title, 20) } })) },
      },
    });
  }

  sendList(from: WaSender, to: string, text: string, button: string, rows: WaListRow[]) {
    return this.send(from, {
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: clip(text, 1024) },
        action: {
          button: clip(button, 20),
          sections: [
            {
              title: 'Opciones',
              rows: rows.slice(0, 10).map((r) => ({
                id: r.id.slice(0, 200),
                title: clip(r.title, 24),
                ...(r.description ? { description: clip(r.description, 72) } : {}),
              })),
            },
          ],
        },
      },
    });
  }

  async downloadMedia(from: WaSender, mediaId: string) {
    const auth = { authorization: `Bearer ${from.accessToken}` };
    const metaRes = await fetch(`${this.config.whatsapp.graphUrl}/${encodeURIComponent(mediaId)}`, {
      headers: auth,
      signal: AbortSignal.timeout(15_000),
    });
    if (!metaRes.ok) throw new Error(`No se pudo obtener el archivo ${mediaId}: ${metaRes.status}`);
    const meta = (await metaRes.json()) as { url: string; mime_type: string; file_size?: number };
    if (meta.file_size && meta.file_size > MEDIA_LIMITS.document) throw new Error('Archivo demasiado grande');
    const fileRes = await fetch(meta.url, { headers: auth, signal: AbortSignal.timeout(60_000) });
    if (!fileRes.ok) throw new Error(`Descarga del archivo ${mediaId} falló: ${fileRes.status}`);
    const data = Buffer.from(await fileRes.arrayBuffer());
    this.logger.debug(`Archivo ${mediaId} descargado (${data.length} bytes)`);
    return { data, mimeType: meta.mime_type };
  }
}
