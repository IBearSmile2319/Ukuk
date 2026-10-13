import { DbService } from '../src/db/db.service';
import { TestContext, createTenant, createTestApp } from './helpers';

describe('núcleo multicliente', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  it('rechaza sin llave o con llave inválida', async () => {
    await ctx.http().get('/v1/account').expect(401);
    await ctx.http().get('/v1/account').set('x-api-key', 'uk_live_x_y').expect(401);
    await ctx.http().post('/admin/tenants').send({}).expect(401);
  });

  it('crea cliente, llave y revoca', async () => {
    const t = await createTenant(ctx, { modules: ['plaft'] });
    const me = await ctx.http().get('/v1/account').set('x-api-key', t.key).expect(200);
    expect(me.body.modules).toEqual(['plaft']);
    expect(me.body.dataKeyEnc).toBeUndefined();
    const keys = await ctx.admin('post', `/admin/tenants/${t.id}/api-keys`).send({ name: 'otra' }).expect(201);
    await ctx.admin('delete', `/admin/tenants/${t.id}/api-keys/${keys.body.id}`).expect(200);
    await ctx.http().get('/v1/account').set('x-api-key', keys.body.key).expect(401);
  });

  it('RLS aísla los datos entre clientes y la auditoría es inalterable', async () => {
    const a = await createTenant(ctx);
    const b = await createTenant(ctx);
    const db = ctx.app.get(DbService);
    const { AuditService } = await import('../src/audit/audit.service');
    const audit = ctx.app.get(AuditService);
    await db.withTenant(a.id, (q) => audit.record(q, a.id, { actor: 'test', action: 'x', entity: 'e', data: { n: 1 } }));
    await db.withTenant(a.id, (q) => audit.record(q, a.id, { actor: 'test', action: 'y', entity: 'e' }));
    await db.withTenant(b.id, (q) => audit.record(q, b.id, { actor: 'test', action: 'z', entity: 'e' }));

    const seenByA = await db.withTenant(a.id, (q) => q.query('SELECT action FROM audit_log ORDER BY id'));
    expect(seenByA.rows.map((r) => r.action)).toEqual(['x', 'y']);
    // Sin app.tenant_id no se ve nada.
    expect((await db.query('SELECT * FROM audit_log')).length).toBe(0);
    // No se puede escribir en nombre de otro cliente.
    await expect(
      db.withTenant(a.id, (q) =>
        q.query(`INSERT INTO audit_log (tenant_id, actor, action, entity, hash) VALUES ($1,'x','x','x','\\x00')`, [b.id]),
      ),
    ).rejects.toThrow();
    await expect(db.withTenant(a.id, (q) => q.query('DELETE FROM audit_log'))).rejects.toThrow(/solo inserción/);

    const v = await ctx.http().get('/v1/account/audit/verify').set('x-api-key', a.key).expect(200);
    expect(v.body).toEqual({ ok: true, entries: 2 });
  });

  it('servicio no contratado devuelve 403', async () => {
    const t = await createTenant(ctx, { modules: [] });
    const usage = await ctx.http().get('/v1/account/usage?month=2026-10').set('x-api-key', t.key).expect(200);
    expect(usage.body.total).toBe(0);
  });
});
