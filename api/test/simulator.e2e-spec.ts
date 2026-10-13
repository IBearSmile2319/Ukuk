import { ConversationService } from '../src/claims/conversation.service';
import { TestContext, createTenant, createTestApp } from './helpers';

const POLICIES = [
  'policy_number,holder_dni,holder_name,plate,product,line,start,end,notice_days,status',
  'VEH-1,45678912,Rosa Quispe,ABC-123,Auto Total,daños,2026-01-01,2027-12-31,,vigente',
].join('\n');

describe('simulador de WhatsApp y página pública', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  it('conversa con el bot sin Meta y aísla por cliente', async () => {
    const a = await createTenant(ctx);
    const b = await createTenant(ctx);
    await ctx.http().post('/v1/claims/policies/import').set('x-api-key', a.key).send({ csv: POLICIES }).expect(201);
    const say = (body: object, key = a.key) =>
      ctx.http().post('/v1/claims/simulator').set('x-api-key', key).send({ from: '51900000001', ...body });

    let r = await say({ text: 'Hola' }).expect(201);
    expect(r.body.messages.map((m: any) => m.direction)).toEqual(['in', 'out']);
    r = await say({ text: '45678912' }).expect(201);
    const out = r.body.messages.at(-1);
    expect(out.type).toBe('list');
    expect(out.payload.rows.length).toBeGreaterThan(0);
    r = await say({ reply_id: out.payload.rows[0].id, reply_title: out.payload.rows[0].title }).expect(201);
    expect(r.body.messages.at(-1).body).toMatch(/¿Cuándo ocurrió\?/);

    const same = await ctx.http().get('/v1/claims/simulator?from=51900000001').set('x-api-key', a.key).expect(200);
    expect(same.body.messages).toHaveLength(r.body.messages.length);
    const other = await ctx.http().get('/v1/claims/simulator?from=51900000001').set('x-api-key', b.key).expect(200);
    expect(other.body).toEqual({ conversation: null, messages: [] });

    await ctx.app.get(ConversationService).drain();
    const noClaims = await createTenant(ctx, { modules: ['plaft'] });
    await say({ text: 'Hola' }, noClaims.key).expect(403);
    await say({ from: 'abc', text: 'x' }).expect(400);
  });

  it('registra interesados y descarta bots', async () => {
    await ctx.http().post('/public/leads').send({ name: 'Ana', company: 'Caja Sur', email: 'ana@cajasur.pe', services: ['plaft'] }).expect(201);
    await ctx.http().post('/public/leads').send({ name: 'Bot', company: 'Spam', email: 'x@y.pe', website: 'http://spam' }).expect(201);
    await ctx.http().post('/public/leads').send({ name: 'A', company: 'B', email: 'no-es-correo' }).expect(400);
    await ctx.http().get('/admin/leads').expect(401);
    const leads = await ctx.admin('get', '/admin/leads').expect(200);
    expect(leads.body.map((l: any) => l.company)).toEqual(['Caja Sur']);
  });
});
