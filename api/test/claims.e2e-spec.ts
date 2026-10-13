import { Client } from 'pg';
import { ConversationService } from '../src/claims/conversation.service';
import { metaSignature } from '../src/claims/webhook-signature';
import { WHATSAPP_CLIENT, WaSender, WhatsAppClient } from '../src/claims/whatsapp.client';
import { PG_ADMIN_URL, TestContext, createTenant, createTestApp } from './helpers';

const APP_SECRET = 'test-app-secret';

/** WhatsApp falso: guarda lo enviado y entrega archivos sin red. */
class FakeWhatsAppClient implements WhatsAppClient {
  sent: { to: string; from: string; type: string; text: string; ids: string[] }[] = [];
  media = new Map<string, { data: Buffer; mimeType: string }>();
  private n = 0;

  private push(from: WaSender, to: string, type: string, text: string, ids: string[] = []) {
    this.sent.push({ to, from: from.phoneNumberId, type, text, ids });
    return Promise.resolve({ id: `wamid.out.${++this.n}` });
  }
  sendText(from: WaSender, to: string, text: string) {
    return this.push(from, to, 'text', text);
  }
  sendButtons(from: WaSender, to: string, text: string, buttons: { id: string }[]) {
    return this.push(from, to, 'buttons', text, buttons.map((b) => b.id));
  }
  sendList(from: WaSender, to: string, text: string, _button: string, rows: { id: string }[]) {
    return this.push(from, to, 'list', text, rows.map((r) => r.id));
  }
  async downloadMedia(_from: WaSender, mediaId: string) {
    const m = this.media.get(mediaId);
    if (!m) throw new Error('media no encontrada');
    return m;
  }
  last() {
    return this.sent[this.sent.length - 1];
  }
}

const POLICIES_CSV = [
  'policy_number,holder_dni,holder_name,plate,product,line,start,end,notice_days,status',
  'VEH-2026-001,12345678,Juan Pérez,ABC-123,Auto Total,daños,2026-01-01,2026-12-31,,vigente',
].join('\n');

describe('siniestros por WhatsApp (e2e)', () => {
  let ctx: TestContext;
  const wa = new FakeWhatsAppClient();
  let a: { id: string; key: string };
  let b: { id: string; key: string };
  let claimId: string;
  let seq = 0;
  const CUSTOMER = '51987654321';

  const payload = (msg: Record<string, unknown>, opts: { wamid?: string; pn?: string; from?: string } = {}) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '51999000111', phone_number_id: opts.pn ?? '106540352242922' },
              contacts: [{ profile: { name: 'Juan' }, wa_id: opts.from ?? CUSTOMER }],
              messages: [
                {
                  from: opts.from ?? CUSTOMER,
                  id: opts.wamid ?? `wamid.in.${++seq}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  ...msg,
                },
              ],
            },
          },
        ],
      },
    ],
  });

  async function send(msg: Record<string, unknown>, opts: { wamid?: string; pn?: string; from?: string } = {}) {
    const body = JSON.stringify(payload(msg, opts));
    await ctx
      .http()
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', metaSignature(APP_SECRET, body))
      .send(body)
      .expect(200);
    await ctx.app.get(ConversationService).drain();
    return wa.last();
  }
  const text = (body: string) => ({ type: 'text', text: { body } });
  const reply = (id: string, title = id) => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
  const listReply = (id: string, title = id) => ({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title } } });

  async function superuser<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const url = new URL(PG_ADMIN_URL);
    url.pathname = `/${ctx.dbName}`;
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: WHATSAPP_CLIENT, useValue: wa }], {
      whatsapp: { appSecret: APP_SECRET, verifyToken: 'verify-me', graphUrl: 'http://graph.invalid' },
      publicBaseUrl: 'https://ukuk.test',
    });
    a = await createTenant(ctx, { name: 'Seguros Andinos', modules: ['claims'] });
    b = await createTenant(ctx, { name: 'Otra Aseguradora', modules: ['claims'] });
    const bind = await ctx.admin('post', '/admin/claims/whatsapp-numbers').send({ tenant_id: a.id, phone_number_id: '106540352242922', display_number: '+51999000111', access_token: 'EAAG-secret' });
    expect(bind.body).toMatchObject({ phone_number_id: '106540352242922' });
    await ctx.admin('post', '/admin/claims/whatsapp-numbers').send({ tenant_id: b.id, phone_number_id: '106540352242933', display_number: '+51999000222' }).expect(201);
    // Un número no se puede reasignar a otro cliente.
    await ctx.admin('post', '/admin/claims/whatsapp-numbers').send({ tenant_id: b.id, phone_number_id: '106540352242922', display_number: '+51999000111' }).expect(400);
  });
  afterAll(() => ctx.close());

  it('verificación del webhook y firma', async () => {
    const ok = await ctx.http().get('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345').expect(200);
    expect(ok.text).toBe('12345');
    await ctx.http().get('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1').expect(403);
    const body = JSON.stringify(payload(text('hola')));
    await ctx.http().post('/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', metaSignature('otro-secreto', body)).send(body).expect(401);
    await ctx.http().post('/webhooks/whatsapp').set('content-type', 'application/json').send(body).expect(401);
    await ctx.app.get(ConversationService).drain();
    expect(wa.sent).toHaveLength(0);
  });

  it('importa pólizas y configura el servicio', async () => {
    const r = await ctx.http().post('/v1/claims/policies/import').set('x-api-key', a.key).send({ csv: POLICIES_CSV }).expect(201);
    expect(r.body).toMatchObject({ imported: 1, errors: [] });
    const cfg = await ctx
      .http()
      .put('/v1/claims/config')
      .set('x-api-key', a.key)
      .send({ gps_max_km: 3, destination: { type: 'email', to: ['ajustador@andinos.pe'] } })
      .expect(200);
    expect(cfg.body.claim_types.map((t: any) => t.code)).toEqual(['choque_leve', 'robo_celular', 'reembolso_salud']);
    expect(cfg.body.gps_max_km).toBe(3);
  });

  it('conversación completa: del saludo al siniestro registrado con foto', async () => {
    let out = await send(text('Hola'));
    expect(out).toMatchObject({ to: CUSTOMER, from: '106540352242922', type: 'text' });
    expect(out.text).toMatch(/Seguros Andinos/);

    out = await send(text('1234567'));
    expect(out.text).toBe('El DNI debe tener 8 dígitos.');

    out = await send(text('12345678'));
    expect(out.type).toBe('list');
    expect(out.text).toMatch(/VEH-2026-001 a nombre de Juan Pérez/);
    expect(out.ids).toEqual(['tipo:choque_leve', 'tipo:robo_celular', 'tipo:otro']);

    out = await send(listReply('tipo:choque_leve', 'Choque leve'));
    expect(out.text).toMatch(/¿Cuándo ocurrió\?/);
    out = await send(text('ayer 10:30'));
    expect(out.text).toMatch(/¿Dónde ocurrió\?/);
    out = await send({ type: 'location', location: { latitude: -12.1211, longitude: -77.0297, name: 'Óvalo de Miraflores' } });
    expect(out.text).toMatch(/qué pasó/);

    out = await send(text('Me chocaron por detrás en el óvalo, daño en el parachoques'));
    expect(out.type).toBe('buttons');
    expect(out.ids).toEqual(['fotos:listo']);
    const link = /https:\/\/ukuk\.test\/capture\/(\S+)/.exec(out.text);
    expect(link).toBeTruthy();
    const token = link![1];

    // "Listo" sin fotos no avanza.
    out = await send(reply('fotos:listo', 'Listo'));
    expect(out.text).toMatch(/Aún no recibimos fotos/);

    const page = await ctx.http().get(`/capture/${token}`).expect(200);
    expect(page.text).toContain('getUserMedia');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    await ctx.http().get(`/capture/${token}x`).expect(404);
    await ctx.http().post(`/capture/${token.slice(0, -2)}aa/photos`).send({ photos: [{ image_base64: 'aGk=', mime_type: 'image/jpeg' }] }).expect(404);

    const photo = Buffer.from('foto-en-vivo-1').toString('base64');
    const up = await ctx
      .http()
      .post(`/capture/${token}/photos`)
      .send({
        photos: [
          { image_base64: photo, mime_type: 'image/jpeg', lat: -12.1215, lng: -77.03, accuracy: 10, captured_at: new Date().toISOString() },
          // Tomada en el Centro de Lima, ~8 km del lugar declarado.
          { image_base64: Buffer.from('foto-en-vivo-2').toString('base64'), mime_type: 'image/jpeg', lat: -12.0464, lng: -77.0428, captured_at: new Date().toISOString() },
        ],
      })
      .expect(201);
    expect(up.body.received).toBe(2);
    expect(up.body.files[0].findings).toEqual([]);
    expect(up.body.files[1].findings.map((f: any) => f.code)).toEqual(['gps_lejano']);

    out = await send(reply('fotos:listo', 'Listo'));
    expect(out.text).toMatch(/Licencia de conducir/);

    wa.media.set('MEDIA-LIC', { data: Buffer.from('licencia-jpg'), mimeType: 'image/jpeg' });
    const docMsg = { type: 'image', image: { id: 'MEDIA-LIC', mime_type: 'image/jpeg' } };
    out = await send(docMsg, { wamid: 'wamid.doc' });
    expect(out.type).toBe('buttons');
    expect(out.text).toMatch(/Resumen:[\s\S]*Fotos: 2[\s\S]*Documentos: 1 de 1/);
    expect(out.ids).toEqual(['confirmar', 'cancelar']);

    // Meta reintenta: el mismo wamid se ignora.
    const before = wa.sent.length;
    await send(docMsg, { wamid: 'wamid.doc' });
    expect(wa.sent.length).toBe(before);

    out = await send(reply('confirmar', 'Confirmar'));
    const number = /registrado con el número (SIN-\d{4}-\d{6})/.exec(out.text)?.[1];
    expect(number).toBeTruthy();

    const list = await ctx.http().get('/v1/claims').set('x-api-key', a.key).expect(200);
    expect(list.body).toHaveLength(1);
    claimId = list.body[0].id;
    const claim = await ctx.http().get(`/v1/claims/${claimId}`).set('x-api-key', a.key).expect(200);
    expect(claim.body).toMatchObject({
      number,
      status: 'revision_analista',
      policy_number: 'VEH-2026-001',
      claim_type: 'choque_leve',
      line: 'daños',
      risk_level: 'alto',
      requires_analyst_review: true,
      late_notice: false,
      location: { lat: -12.1211, lng: -77.0297 },
    });
    expect(claim.body.risk_reasons.join(' ')).toMatch(/gps_lejano/);
    expect(claim.body.deadlines).toMatchObject({ notice_days: 3, late_notice: false, day_count: 0, can_request_clarification: true, consented: false });
    expect(claim.body.deadlines.notice_deadline).toBeTruthy();
    expect(claim.body.deadlines.consent_deadline).toBeTruthy();
    expect(claim.body.files.map((f: any) => [f.kind, f.source])).toEqual([
      ['photo', 'capture'],
      ['photo', 'capture'],
      ['document', 'whatsapp'],
    ]);
    expect(claim.body.files[0].capture).toMatchObject({ lat: -12.1215, distance_km: expect.any(Number) });
    const inbound = claim.body.transcript.filter((m: any) => m.direction === 'in').length;
    const outbound = claim.body.transcript.filter((m: any) => m.direction === 'out').length;
    expect(inbound).toBe(11);
    expect(outbound).toBe(11);
    expect(inbound + outbound).toBeLessThanOrEqual(22);

    // Archivo descifrado para el analista.
    const file = await ctx.http().get(`/v1/claims/${claimId}/files/${claim.body.files[2].id}`).set('x-api-key', a.key).expect(200);
    expect(file.headers['content-type']).toBe('image/jpeg');

    // Uso facturable: 1 siniestro y cada mensaje de WhatsApp (entrada y salida).
    const usage = await ctx.http().get(`/v1/account/usage?month=${new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 7)}`).set('x-api-key', a.key).expect(200);
    expect(usage.body.lines).toEqual(expect.arrayContaining([expect.objectContaining({ description: 'claim', quantity: 1 })]));
    expect(usage.body.passthroughUsd).toEqual([{ unit: 'whatsapp_message', quantity: inbound + outbound, amount: Math.round((inbound + outbound) * 3) / 100 }]);

    const audit = await ctx.http().get(`/v1/account/audit?entity=claim&entity_id=${claimId}`).set('x-api-key', a.key).expect(200);
    expect(audit.body.map((e: any) => e.action)).toEqual(expect.arrayContaining(['claim.created', 'claim.photos_captured']));
  });

  it('aislamiento entre clientes y servicio no contratado', async () => {
    await ctx.http().get(`/v1/claims/${claimId}`).set('x-api-key', b.key).expect(404);
    const listB = await ctx.http().get('/v1/claims').set('x-api-key', b.key).expect(200);
    expect(listB.body).toEqual([]);
    const c = await createTenant(ctx, { modules: ['documents'] });
    await ctx.http().get('/v1/claims').set('x-api-key', c.key).expect(403);
    // Un mensaje al número de B abre una conversación de B, no ve nada de A.
    const out = await send(text('hola'), { pn: '106540352242933' });
    expect(out).toMatchObject({ from: '106540352242933', text: expect.stringMatching(/Otra Aseguradora/) });
  });

  it('analista antes del ajustador; aclaración rechazada pasado el día 20', async () => {
    await ctx.http().post(`/v1/claims/${claimId}/decision`).set('x-api-key', a.key).send({ decision: 'aprobado' }).expect(409);
    const rev = await ctx.http().post(`/v1/claims/${claimId}/review`).set('x-api-key', a.key).set('x-ukuk-user', 'analista@andinos.pe').send({ action: 'approve_to_adjuster' }).expect(201);
    expect(rev.body.status).toBe('ajustador');

    // Simula que la documentación quedó completa hace 25 días.
    await superuser((c) => c.query(`UPDATE claims SET docs_complete_at = now() - interval '25 days' WHERE id = $1`, [claimId]));
    const late = await ctx
      .http()
      .post(`/v1/claims/${claimId}/decision`)
      .set('x-api-key', a.key)
      .send({ decision: 'aclaracion', note: 'Enviar foto del otro vehículo' })
      .expect(422);
    expect(late.body.message).toMatch(/día 20/);
    expect(late.body.day_count).toBe(25);

    const alerts = await ctx.http().get('/v1/claims/alerts').set('x-api-key', a.key).expect(200);
    expect(alerts.body.map((x: any) => x.kind).sort()).toEqual(['dia_20', 'dia_25']);

    const due = await ctx.http().get('/v1/claims?due_within_days=7').set('x-api-key', a.key).expect(200);
    expect(due.body.map((x: any) => x.id)).toEqual([claimId]);

    const before = wa.sent.length;
    const ok = await ctx.http().post(`/v1/claims/${claimId}/decision`).set('x-api-key', a.key).send({ decision: 'aprobado' }).expect(201);
    expect(ok.body.status).toBe('aprobado');
    expect(ok.body.deadlines.payment_deadline).toBeTruthy();
    // Se avisa al asegurado por WhatsApp.
    expect(wa.sent.length).toBe(before + 1);
    expect(wa.last().text).toMatch(/fue aprobado/);

    const audit = await ctx.http().get(`/v1/account/audit?entity=claim&entity_id=${claimId}`).set('x-api-key', a.key).expect(200);
    const review = audit.body.find((e: any) => e.action === 'claim.review.approve_to_adjuster');
    expect(review.actor).toBe('user:analista@andinos.pe');
    const verify = await ctx.http().get('/v1/account/audit/verify').set('x-api-key', a.key).expect(200);
    expect(verify.body.ok).toBe(true);
  });

  it('barrido: caso sin respuesta en 30 días queda consentido', async () => {
    // Segundo caso: robo de celular, sin fotos, documento pendiente → luego completo.
    const from = '51911111111';
    await send(text('hola'), { from });
    await send(text('ABC123'), { from });
    await send(listReply('tipo:robo_celular'), { from });
    await send(text('ayer 21:00'), { from });
    await send(text('Jr. de la Unión 500, Lima'), { from });
    await send(text('Me arrancharon el celular al salir del metro'), { from });
    let out = await send(reply('doc:despues', 'Después'), { from });
    expect(out.text).toMatch(/pendiente: Denuncia policial/);
    out = await send(reply('confirmar'), { from });
    expect(out.text).toMatch(/documentos pendientes/);

    const list = await ctx.http().get('/v1/claims?status=ajustador').set('x-api-key', a.key).expect(200);
    expect(list.body).toHaveLength(1);
    const id = list.body[0].id;
    const c = await ctx.http().get(`/v1/claims/${id}`).set('x-api-key', a.key).expect(200);
    expect(c.body).toMatchObject({ risk_level: 'bajo', missing_docs: ['denuncia_policial'] });
    expect(c.body.deadlines.consent_deadline).toBeNull();

    await ctx.http().post(`/v1/claims/${id}/documents-complete`).set('x-api-key', a.key).expect(201);
    await superuser((q) => q.query(`UPDATE claims SET docs_complete_at = now() - interval '32 days' WHERE id = $1`, [id]));
    const alerts = await ctx.http().get('/v1/claims/alerts').set('x-api-key', a.key).expect(200);
    expect(alerts.body.filter((x: any) => x.claim_id === id).map((x: any) => x.kind).sort()).toEqual(['consentido', 'dia_20', 'dia_25', 'dia_28']);
    const after = await ctx.http().get(`/v1/claims/${id}`).set('x-api-key', a.key).expect(200);
    expect(after.body.status).toBe('consentido');
    expect(after.body.payment_deadline).toBeTruthy();
    await ctx.http().post(`/v1/claims/${id}/decision`).set('x-api-key', a.key).send({ decision: 'rechazado', note: 'tarde' }).expect(409);
  });

  it('cancelar y pedir asesor', async () => {
    const from = '51922222222';
    await send(text('hola'), { from });
    let out = await send(text('asesor'), { from });
    expect(out.text).toMatch(/asesor/);
    const count = wa.sent.length;
    // Con un asesor a cargo el bot no responde.
    await send(text('¿hola?'), { from });
    expect(wa.sent.length).toBe(count);

    const from2 = '51933333333';
    await send(text('hola'), { from: from2 });
    out = await send(text('cancelar'), { from: from2 });
    expect(out.text).toMatch(/cancelado/);
  });
});
