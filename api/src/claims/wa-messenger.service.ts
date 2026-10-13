import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { CryptoService, open, seal } from '../crypto/crypto.service';
import { DbService, Queryable } from '../db/db.service';
import { Tenant } from '../tenancy/tenant';
import { UsageService } from '../usage/usage.service';
import { Button } from './conversation';
import { WHATSAPP_CLIENT, WaListRow, WaSender, WhatsAppClient } from './whatsapp.client';

export type ResolvedOut =
  | { type: 'text'; text: string }
  | { type: 'buttons'; text: string; buttons: Button[] }
  | { type: 'list'; text: string; button: string; rows: WaListRow[] };

export interface WaNumberRow {
  phone_number_id: string;
  tenant_id: string;
  display_number: string;
  access_token_enc: Buffer | null;
  secret_ref: string | null;
  active: boolean;
}

/**
 * Mensajes salientes: se registran (transcripción + uso facturable) dentro de la
 * transacción del caso y se envían después del COMMIT, para no mandar nada que
 * luego se deshaga.
 */
@Injectable()
export class WaMessenger {
  private readonly logger = new Logger(WaMessenger.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WHATSAPP_CLIENT) private readonly wa: WhatsAppClient,
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly usage: UsageService,
  ) {}

  async number(phoneNumberId: string): Promise<WaNumberRow | undefined> {
    return (await this.db.query<WaNumberRow>('SELECT * FROM wa_numbers WHERE phone_number_id = $1', [phoneNumberId]))[0];
  }

  sealToken(tenant: Tenant, phoneNumberId: string, token: string): Buffer {
    return seal(this.crypto.dataKey(tenant.id, tenant.dataKeyEnc), Buffer.from(token), Buffer.from(`wa:${phoneNumberId}`));
  }

  sender(tenant: Tenant, n: WaNumberRow): WaSender {
    let accessToken = '';
    if (n.access_token_enc) {
      accessToken = open(this.crypto.dataKey(tenant.id, tenant.dataKeyEnc), n.access_token_enc, Buffer.from(`wa:${n.phone_number_id}`)).toString();
    } else if (n.secret_ref) {
      accessToken = process.env[n.secret_ref] ?? '';
    }
    return { phoneNumberId: n.phone_number_id, accessToken: accessToken || this.config.whatsapp.accessToken || '' };
  }

  /** Registra los mensajes salientes y su uso; devuelve los ids para completar el wamid. */
  async record(db: Queryable, tenant: Tenant, conversationId: string, outs: ResolvedOut[], claimId?: string | null): Promise<number[]> {
    const ids: number[] = [];
    for (const o of outs) {
      const r = await db.query<{ id: string }>(
        `INSERT INTO claim_messages (tenant_id, conversation_id, direction, type, body, payload)
         VALUES ($1,$2,'out',$3,$4,$5) RETURNING id`,
        [tenant.id, conversationId, o.type, o.text, o],
      );
      ids.push(Number(r.rows[0].id));
      await this.usage.record(db, tenant.id, 'claims', 'whatsapp_message', 1, claimId ?? conversationId);
    }
    if (outs.length) {
      await db.query('UPDATE claim_conversations SET message_count = message_count + $2 WHERE id = $1', [conversationId, outs.length]);
    }
    return ids;
  }

  /** Envía en orden; si uno falla se registra y se sigue (el caso no se pierde). */
  async deliver(tenant: Tenant, from: WaSender, to: string, outs: ResolvedOut[], ids: number[]): Promise<void> {
    const sent: [number, string][] = [];
    for (let i = 0; i < outs.length; i++) {
      const o = outs[i];
      try {
        const r =
          o.type === 'text'
            ? await this.wa.sendText(from, to, o.text)
            : o.type === 'buttons'
              ? await this.wa.sendButtons(from, to, o.text, o.buttons)
              : await this.wa.sendList(from, to, o.text, o.button, o.rows);
        if (r.id) sent.push([ids[i], r.id]);
      } catch (err) {
        this.logger.error(`No se pudo enviar el mensaje ${ids[i]} a WhatsApp: ${(err as Error).message}`);
      }
    }
    if (sent.length) {
      await this.db.withTenant(tenant.id, async (db) => {
        for (const [id, wamid] of sent) await db.query('UPDATE claim_messages SET wamid = $2 WHERE id = $1', [id, wamid]);
      });
    }
  }
}
