import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAMPLE_NORM_TEXT } from '../src/regulatory/sources/fixtures/sample-norm';
import { TestContext, createTenant, createTestApp } from './helpers';

const today = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);

const PROCESSES_CSV = [
  'code,name,kind,description,owner_email,topics,keywords',
  'SIN-01,Atención de siniestros,proceso,"Recepción del aviso de siniestro, canales digitales de atención al asegurado y plazo de pronunciamiento",siniestros@aseg.pe,siniestros|seguros,aviso de siniestro|whatsapp',
  'TES-01,Manual de tesorería,manual,Inversiones y conciliaciones bancarias,,tesoreria,inversiones',
  ',sin código,proceso,,,,',
].join('\n');

describe('radar regulatorio (e2e)', () => {
  let ctx: TestContext;
  let aseg: { id: string; key: string };
  let banco: { id: string; key: string };
  let generalId: string;
  let projectId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    aseg = await createTenant(ctx, { modules: ['regulatory'], businessLines: ['seguros', 'siniestros'] });
    banco = await createTenant(ctx, { name: 'Banco Prueba', entityType: 'banco', modules: ['regulatory'], businessLines: ['credito'] });
  });
  afterAll(() => ctx.close());

  it('cliente sin el servicio recibe 403', async () => {
    const other = await createTenant(ctx, { modules: ['documents'] });
    await ctx.http().get('/v1/regulatory/digest').set('x-api-key', other.key).expect(403);
    await ctx.http().post('/admin/regulatory/norms').send({ norms: [] }).expect(401);
  });

  it('importa el inventario de procesos por CSV', async () => {
    const r = await ctx.http().post('/v1/regulatory/processes/import').set('x-api-key', aseg.key).send({ csv: PROCESSES_CSV }).expect(201);
    expect(r.body).toMatchObject({ imported: 2, created: 2, errors: [{ line: 4 }] });
    await ctx
      .http()
      .post('/v1/regulatory/processes')
      .set('x-api-key', banco.key)
      .send({ code: 'SIN-B', name: 'Siniestros bancaseguros', kind: 'proceso', description: 'Aviso de siniestro de seguros de desgravamen', topics: ['siniestros', 'seguros'], keywords: ['aviso de siniestro'] })
      .expect(201);
  });

  it('ingesta: norma general genera impactos; la particular se ignora', async () => {
    const r = await ctx
      .admin('post', '/admin/regulatory/norms')
      .send({
        norms: [
          {
            source: 'sbs',
            external_id: 'RES-SBS-03050-2026',
            number: 'Res. SBS N° 03050-2026',
            title: 'Aprueban Reglamento de Gestión de Siniestros',
            published_at: today,
            text: SAMPLE_NORM_TEXT,
          },
          {
            source: 'el_peruano',
            external_id: '2450002-1',
            number: 'Res. SBS N° 03051-2026',
            title: 'Autorizan a La Positiva Seguros y Reaseguros S.A.A. el cierre de agencia de siniestros',
            published_at: today,
            text: 'Artículo Único.- Autorizar el cierre de la agencia de atención de siniestros de seguros.',
          },
        ],
      })
      .expect(201);
    expect(r.body.map((n: any) => [n.scope, n.created, n.tenants_with_impacts])).toEqual([
      ['general', true, 1],
      ['particular', true, 0],
    ]);
    generalId = r.body[0].id;

    const digest = await ctx.http().get(`/v1/regulatory/digest?date=${today}`).set('x-api-key', aseg.key).expect(200);
    expect(digest.body.new_norms).toHaveLength(1);
    const n = digest.body.new_norms[0];
    expect(n).toMatchObject({ id: generalId, effective_at: '2027-01-01' });
    expect(n.impacts.map((i: any) => i.process_code)).toEqual(['SIN-01']);
    expect(n.impacts[0].articles).toContain('2');

    // El banco tiene un proceso afín, pero la norma va dirigida a empresas de seguros.
    const bd = await ctx.http().get(`/v1/regulatory/digest?date=${today}`).set('x-api-key', banco.key).expect(200);
    expect(bd.body.new_norms).toEqual([]);
  });

  it('reingresar la misma norma no duplica', async () => {
    const r = await ctx
      .admin('post', '/admin/regulatory/norms')
      .send({ norms: [{ source: 'sbs', external_id: 'RES-SBS-03050-2026', title: 'Aprueban Reglamento de Gestión de Siniestros', published_at: today, text: SAMPLE_NORM_TEXT }] })
      .expect(201);
    expect(r.body[0]).toMatchObject({ id: generalId, created: false });
  });

  it('búsqueda de normas y detalle con impactos del cliente', async () => {
    const q = await ctx.http().get('/v1/regulatory/norms?q=whatsapp').set('x-api-key', aseg.key).expect(200);
    expect(q.body.map((n: any) => n.id)).toEqual([generalId]);
    const p = await ctx.http().get('/v1/regulatory/norms?scope=particular').set('x-api-key', aseg.key).expect(200);
    expect(p.body).toHaveLength(1);
    const d = await ctx.http().get(`/v1/regulatory/norms/${generalId}`).set('x-api-key', aseg.key).expect(200);
    expect(d.body.articles.map((a: any) => a.number)).toEqual(['1', '2', '3', 'DCF-1', 'DCF-2']);
    expect(d.body.impacts).toHaveLength(1);
    const db = await ctx.http().get(`/v1/regulatory/norms/${generalId}`).set('x-api-key', banco.key).expect(200);
    expect(db.body.impacts).toEqual([]);
  });

  it('matriz de impacto, estado y tareas con vencidas', async () => {
    const m = await ctx.http().get('/v1/regulatory/impact-matrix').set('x-api-key', aseg.key).expect(200);
    expect(m.body.length).toBeGreaterThanOrEqual(1);
    expect(m.body[0]).toMatchObject({ process_code: 'SIN-01', effective_at: '2027-01-01', status: 'pendiente' });
    const csv = await ctx.http().get('/v1/regulatory/impact-matrix?format=csv').set('x-api-key', aseg.key).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\n')[0]).toMatch(/^norma,titulo,articulo,proceso_codigo/);

    const impactId = m.body[0].impact_id;
    await ctx.http().patch(`/v1/regulatory/impacts/${impactId}`).set('x-api-key', banco.key).send({ status: 'adecuado' }).expect(404);
    const task = await ctx
      .http()
      .post('/v1/regulatory/tasks')
      .set('x-api-key', aseg.key)
      .send({ impact_id: impactId, title: 'Habilitar canal WhatsApp para avisos', responsible_email: 'Ops@aseg.pe', due_at: '2026-01-31' })
      .expect(201);
    expect(task.body).toMatchObject({ status: 'abierta', overdue: true, responsible_email: 'ops@aseg.pe' });
    const overdue = await ctx.http().get('/v1/regulatory/tasks/overdue').set('x-api-key', aseg.key).expect(200);
    expect(overdue.body.map((t: any) => t.id)).toEqual([task.body.id]);
    const closed = await ctx
      .http()
      .patch(`/v1/regulatory/tasks/${task.body.id}`)
      .set('x-api-key', aseg.key)
      .send({ status: 'cerrada', evidence: 'Canal habilitado, acta 12' })
      .expect(200);
    expect(closed.body.closed_at).toBeTruthy();
    await ctx.http().patch(`/v1/regulatory/impacts/${impactId}`).set('x-api-key', aseg.key).send({ status: 'adecuado', note: 'ok' }).expect(200);
    const after = await ctx.http().get('/v1/regulatory/tasks/overdue').set('x-api-key', aseg.key).expect(200);
    expect(after.body).toEqual([]);

    const audit = await ctx.http().get('/v1/account/audit?entity=reg_task').set('x-api-key', aseg.key).expect(200);
    expect(audit.body.map((a: any) => a.action)).toEqual(['regulatory.task_closed', 'regulatory.task_created']);
    const v = await ctx.http().get('/v1/account/audit/verify').set('x-api-key', aseg.key).expect(200);
    expect(v.body.ok).toBe(true);
  });

  it('proyecto prepublicado: aparece en consultas y genera borrador de comentarios', async () => {
    const r = await ctx
      .admin('post', '/admin/regulatory/norms')
      .send({
        norms: [
          {
            source: 'sbs',
            external_id: 'PROY-2026-0045',
            number: 'Proyecto SBS 2026-0045',
            title: 'Proyecto de Resolución que modifica el Reglamento de Gestión de Siniestros',
            published_at: today,
            text:
              'Los interesados podrán remitir sus comentarios hasta el 31 de diciembre de 2099 al correo prepublicacion@sbs.gob.pe.\n' +
              'Artículo 1.- Aviso de siniestro\nLas empresas de seguros deben recibir el aviso de siniestro por WhatsApp y otros canales digitales del asegurado.',
          },
        ],
      })
      .expect(201);
    projectId = r.body[0].id;
    expect(r.body[0].status).toBe('proyecto');
    const digest = await ctx.http().get(`/v1/regulatory/digest?date=${today}`).set('x-api-key', aseg.key).expect(200);
    expect(digest.body.consultations.map((c: any) => [c.id, c.comments_deadline])).toEqual([[projectId, '2099-12-31']]);
    expect(digest.body.new_norms.map((n: any) => n.id)).toEqual([generalId]);

    const draft = await ctx.http().post(`/v1/regulatory/norms/${projectId}/comment-draft`).set('x-api-key', aseg.key).expect(201);
    expect(draft.body.method).toBe('plantilla');
    expect(draft.body.draft).toMatch(/Enviar a: prepublicacion@sbs\.gob\.pe/);
    expect(draft.body.draft).toMatch(/SIN-01 Atención de siniestros/);
    await ctx.http().post(`/v1/regulatory/norms/${generalId}/comment-draft`).set('x-api-key', aseg.key).expect(400);
  });

  it('ingesta manual por adaptadores sin fuentes habilitadas no hace nada', async () => {
    const r = await ctx.admin('post', '/admin/regulatory/ingest').send({}).expect(200);
    expect(r.body.sources).toEqual([]);
    // El fixture de El Peruano está disponible para pruebas sin red.
    expect(readFileSync(join(__dirname, '../src/regulatory/sources/fixtures/el-peruano.html'), 'utf8')).toMatch(/Siniestros/);
  });
});
