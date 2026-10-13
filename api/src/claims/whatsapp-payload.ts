import { Inbound } from './conversation';

/** Mensaje entrante extraído del webhook de Meta (entry[].changes[].value.messages[]). */
export interface WaInboundMessage {
  phoneNumberId: string;
  from: string;
  profileName?: string;
  wamid: string;
  timestamp: Date;
  type: string;
  /** Texto para la transcripción. */
  body: string | null;
  input: Inbound;
  /** Archivo por descargar (id de Graph), si lo hay. */
  media?: { id: string; kind: 'image' | 'video' | 'audio' | 'document'; mimeType: string; filename?: string; caption?: string };
}

const MEDIA_KINDS = ['image', 'video', 'audio', 'document', 'sticker'] as const;

export function parseWebhookPayload(payload: any): WaInboundMessage[] {
  const out: WaInboundMessage[] = [];
  if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return out;
  for (const entry of payload.entry) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue;
      const value = change.value ?? {};
      const phoneNumberId = value.metadata?.phone_number_id;
      if (typeof phoneNumberId !== 'string') continue;
      const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages ?? []) {
        if (typeof m?.id !== 'string' || typeof m?.from !== 'string') continue;
        const base = {
          phoneNumberId,
          from: m.from,
          profileName: names.get(m.from),
          wamid: m.id,
          timestamp: new Date(Number(m.timestamp ?? 0) * 1000 || Date.now()),
          type: String(m.type),
        };
        out.push({ ...base, ...toInput(m) });
      }
    }
  }
  return out;
}

function toInput(m: any): Pick<WaInboundMessage, 'body' | 'input' | 'media'> {
  switch (m.type) {
    case 'text':
      return { body: m.text?.body ?? '', input: { kind: 'text', text: String(m.text?.body ?? '') } };
    case 'interactive': {
      const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
      if (!r?.id) return { body: null, input: { kind: 'unsupported' } };
      return { body: r.title ?? r.id, input: { kind: 'reply', id: String(r.id), title: String(r.title ?? '') } };
    }
    case 'button':
      // Respuesta rápida de una plantilla.
      return { body: m.button?.text ?? '', input: { kind: 'reply', id: String(m.button?.payload ?? m.button?.text ?? ''), title: String(m.button?.text ?? '') } };
    case 'location': {
      const l = m.location ?? {};
      if (!Number.isFinite(l.latitude) || !Number.isFinite(l.longitude)) return { body: null, input: { kind: 'unsupported' } };
      return {
        body: [l.name, l.address].filter(Boolean).join(' — ') || `${l.latitude},${l.longitude}`,
        input: { kind: 'location', lat: l.latitude, lng: l.longitude, name: l.name, address: l.address },
      };
    }
  }
  if ((MEDIA_KINDS as readonly string[]).includes(m.type) && m[m.type]?.id) {
    const kind = m.type === 'sticker' ? 'image' : (m.type as 'image' | 'video' | 'audio' | 'document');
    const media = m[m.type];
    return {
      body: media.caption ?? media.filename ?? null,
      // El fileId real lo asigna el servicio tras descargar y guardar el archivo.
      input: { kind: 'media', media: kind, fileId: '', mimeType: media.mime_type ?? 'application/octet-stream', caption: media.caption },
      media: { id: media.id, kind, mimeType: media.mime_type ?? 'application/octet-stream', filename: media.filename, caption: media.caption },
    };
  }
  return { body: null, input: { kind: 'unsupported' } };
}
