import { EngineClient } from '../src/engine/engine.client';
import { ADVERSE_MEDIA_PROVIDER } from '../src/plaft/adverse-media';
import { WATCHLIST_FETCHER, WATCHLIST_SOURCES } from '../src/plaft/watchlist-sync.service';
import { FakeEngine, TestContext, createTenant, createTestApp } from './helpers';

const match = (entry_id: string, category = 'sanction', source = 'ofac_sdn', score = 0.93) => ({
  source,
  category,
  entry_id,
  name: `PEREZ DE LA CRUZ, Juan (${entry_id})`,
  matched_name: 'PEREZ DE LA CRUZ, Juan',
  score,
  kind: 'individual',
  programs: ['SDNTK'],
  birth_dates: ['1970'],
  nationalities: ['PE'],
  reasons: ['tokens: 4/4'],
});

describe('servicio PLAFT', () => {
  let ctx: TestContext;
  const engine = new FakeEngine();
  const fetched: string[] = [];
  /** Coincidencias por nombre (en mayúsculas) que devuelve el motor falso. */
  const hits = new Map<string, any[]>();
  const news = { articles: [] as any[] };

  beforeAll(async () => {
    engine.screenImpl = (req) => {
      const name = String(req.name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
      const matches = [...hits.entries()].filter(([k]) => name.includes(k)).flatMap(([, v]) => v);
      return { query_normalized: name, matches };
    };
    ctx = await createTestApp([
      { provide: EngineClient, useValue: engine },
      { provide: ADVERSE_MEDIA_PROVIDER, useValue: { name: 'fake', search: async () => news.articles } },
      {
        provide: WATCHLIST_SOURCES,
        useValue: [
          { source: 'ofac_sdn', url: 'https://example.test/sdn.csv', format: 'ofac_sdn_csv', category: 'sanction' },
          { source: 'un', url: 'https://example.test/un.xml', format: 'un_xml', category: 'sanction' },
        ],
      },
      {
        provide: WATCHLIST_FETCHER,
        useValue: async (url: string) => {
          fetched.push(url);
          return Buffer.from(`contenido de ${url}`);
        },
      },
    ]);
  });
  afterAll(() => ctx.close());
  afterEach(() => hits.clear());

  const post = (key: string, path: string, body: object) => ctx.http().post(path).set('x-api-key', key).send(body);
  const get = (key: string, path: string) => ctx.http().get(path).set('x-api-key', key);

  it('vinculación con coincidencia → caso → decisión auditada', async () => {
    const t = await createTenant(ctx, { modules: ['plaft'] });
    hits.set('PEREZ DE LA CRUZ', [match('12345'), match('12345', 'sanction', 'ofac_sdn', 0.9)]);
    const res = await post(t.key, '/v1/plaft/subjects', {
      relation: 'cliente',
      kind: 'individual',
      name: 'Juan Carlos Pérez de la Cruz',
      doc_type: 'dni',
      doc_number: '12345678',
      birth_date: '1970-02-03',
      nationality: 'pe',
      monitor: true,
    }).expect(201);
    expect(res.body.subject).toMatchObject({ regime: 'reforzado', risk_factors: ['coincidencia_sancion'], doc_type: 'DNI', nationality: 'PE' });
    const years = (new Date(res.body.subject.next_review_at).getTime() - Date.now()) / (365.25 * 86400e3);
    expect(years).toBeCloseTo(1, 1);
    expect(res.body.case_id).toBeTruthy();
    expect(res.body.screening.adverse_media).toMatchObject({ provider: 'fake', articles: [] });
    const screenCall = engine.calls.filter((c) => c.method === 'screen').pop()!.args[0] as any;
    expect(screenCall.threshold).toBe(0.85);

    const open = await get(t.key, '/v1/plaft/cases?status=abierto').expect(200);
    expect(open.body.total).toBe(1);
    expect(open.body.items[0]).toMatchObject({ id: res.body.case_id, matches: 1, subject_name: 'Juan Carlos Pérez de la Cruz' });

    const caseId = res.body.case_id;
    await post(t.key, `/v1/plaft/cases/${caseId}/decision`, { decision: 'falso_positivo', rationale: 'corto' }).expect(400);
    await post(t.key, `/v1/plaft/cases/${caseId}/decision`, { decision: 'archivar', rationale: 'x'.repeat(30) }).expect(400);
    const decided = await post(t.key, `/v1/plaft/cases/${caseId}/decision`, {
      decision: 'falso_positivo',
      rationale: 'Fecha de nacimiento y nacionalidad distintas a la entrada OFAC; homónimo.',
      analyst: 'oficial.cumplimiento',
    }).expect(201);
    expect(decided.body).toMatchObject({ status: 'cerrado', decision: 'falso_positivo', ros_draft: false, decided_by: 'analyst:oficial.cumplimiento' });
    expect(decided.body.matches[0].status).toBe('descartada');
    expect(decided.body.subject.regime).toBe('general');
    expect(decided.body.timeline.map((e: any) => e.type)).toEqual(['opened', 'decided']);
    await post(t.key, `/v1/plaft/cases/${caseId}/decision`, { decision: 'escalado_uif', rationale: 'x'.repeat(30) }).expect(409);

    const audit = await get(t.key, `/v1/account/audit?entity=plaft_case&entity_id=${caseId}`).expect(200);
    expect(audit.body.map((e: any) => e.action).sort()).toEqual(['plaft_case.decided', 'plaft_case.opened']);
    expect((await get(t.key, '/v1/account/audit/verify')).body).toMatchObject({ ok: true });

    const subject = await get(t.key, `/v1/plaft/subjects/${res.body.subject.id}`).expect(200);
    expect(subject.body.screenings).toHaveLength(1);
    expect(subject.body.cases[0]).toMatchObject({ id: caseId, decision: 'falso_positivo' });

    const month = new Date().toISOString().slice(0, 7);
    const usage = await get(t.key, `/v1/account/usage?month=${month}`).expect(200);
    expect(usage.body.lines.find((l: any) => l.description === 'onboarding_check').quantity).toBe(1);

    // Otro cliente no ve el caso.
    const other = await createTenant(ctx, { modules: ['plaft'] });
    await get(other.key, `/v1/plaft/cases/${caseId}`).expect(404);
    await get(other.key, `/v1/plaft/subjects/${res.body.subject.id}`).expect(404);
  });

  it('escalado a la UIF deja borrador de ROS', async () => {
    const t = await createTenant(ctx, { modules: ['plaft'] });
    hits.set('ROSA', [match('pep-1', 'pep', 'pep_pe')]);
    const res = await post(t.key, '/v1/plaft/subjects', {
      relation: 'director', kind: 'individual', name: 'Rosa Quispe', doc_type: 'DNI', doc_number: '44445555', monitor: false,
    }).expect(201);
    expect(res.body.subject.regime).toBe('reforzado');
    const d = await post(t.key, `/v1/plaft/cases/${res.body.case_id}/decision`, {
      decision: 'escalado_uif',
      rationale: 'Coincidencia confirmada con PEP y operaciones inusuales en el periodo.',
    }).expect(201);
    expect(d.body).toMatchObject({ status: 'cerrado', ros_draft: true });
    expect(d.body.subject.regime).toBe('reforzado');
  });

  it('valida documentos, duplicados, proveedores a 2 años y módulo no contratado', async () => {
    const t = await createTenant(ctx, { modules: ['plaft'], settings: { plaft_allow_simplified: true } });
    const base = { relation: 'cliente', kind: 'individual', name: 'Ana Torres', doc_type: 'DNI', monitor: true };
    await post(t.key, '/v1/plaft/subjects', { ...base, doc_number: '1234' }).expect(400);
    await post(t.key, '/v1/plaft/subjects', { ...base, kind: 'entity', name: 'Andina SAC', doc_type: 'RUC', doc_number: '99999999999' }).expect(400);
    await post(t.key, '/v1/plaft/subjects', { ...base, relation: 'socio', doc_number: '12345678' }).expect(400);
    const ok = await post(t.key, '/v1/plaft/subjects', { ...base, doc_number: '87654321' }).expect(201);
    expect(ok.body.subject.regime).toBe('simplificado');
    expect(ok.body.case_id).toBeNull();
    await post(t.key, '/v1/plaft/subjects', { ...base, doc_number: '87654321' }).expect(409);

    const prov = await post(t.key, '/v1/plaft/subjects', {
      relation: 'proveedor', kind: 'entity', name: 'Constructora Andina SAC', doc_type: 'RUC', doc_number: '20100047218', monitor: true,
    }).expect(201);
    const years = (new Date(prov.body.subject.next_review_at).getTime() - Date.now()) / (365.25 * 86400e3);
    expect(years).toBeCloseTo(2, 1);
    const risky = await post(t.key, '/v1/plaft/subjects', { ...base, doc_type: 'PASAPORTE', doc_number: 'X1234567', nationality: 'IR' }).expect(201);
    expect(risky.body.subject).toMatchObject({ regime: 'reforzado', risk_factors: ['pais_alto_riesgo'] });

    const list = await get(t.key, '/v1/plaft/subjects?relation=proveedor').expect(200);
    expect(list.body.items.map((s: any) => s.id)).toEqual([prov.body.subject.id]);
    expect((await get(t.key, '/v1/plaft/subjects?q=andina')).body.total).toBe(1);

    const noPlaft = await createTenant(ctx, { modules: ['documents'] });
    await post(noPlaft.key, '/v1/plaft/subjects', { ...base, doc_number: '87654321' }).expect(403);
  });

  it('carga masiva en CSV con revisión por lotes', async () => {
    const t = await createTenant(ctx, { modules: ['plaft'] });
    hits.set('LAVADO', [match('999')]);
    const csv = [
      'name;kind;relation;doc_type;doc_number;birth_date;nationality',
      'Pedro Lavado Ruiz;individual;cliente;DNI;11111111;1980-01-01;PE',
      'María Gómez;individual;trabajador;DNI;22222222;;',
      '"Inversiones Sur; S.A.";entity;proveedor;RUC;20100047218;;',
      'Mal Documento;individual;cliente;DNI;12;;',
      'RUC Malo SAC;entity;proveedor;RUC;99999999999;;',
    ].join('\r\n');
    const upload = () =>
      ctx.http().post('/v1/plaft/subjects/bulk').set('x-api-key', t.key).attach('file', Buffer.from(csv), { filename: 'cartera.csv', contentType: 'text/csv' });
    const before = engine.calls.filter((c) => c.method === 'screenBatch').length;
    const res = await upload().expect(201);
    expect(res.body).toMatchObject({ received: 5, created: 3, updated: 0, screened: 3, with_matches: 1, cases_opened: 1 });
    expect(res.body.errors.map((e: any) => e.line)).toEqual([5, 6]);
    expect(engine.calls.filter((c) => c.method === 'screenBatch').length).toBe(before + 1);

    const again = await upload().expect(201);
    expect(again.body).toMatchObject({ created: 0, updated: 3, cases_opened: 0 });
    expect((await get(t.key, '/v1/plaft/cases')).body.total).toBe(1);
    const prov = (await get(t.key, '/v1/plaft/subjects?relation=proveedor')).body.items[0];
    expect(prov.name).toBe('Inversiones Sur; S.A.');

    await ctx.http().post('/v1/plaft/subjects/bulk').set('x-api-key', t.key)
      .attach('file', Buffer.from('nombre,tipo\nx,y'), { filename: 'a.csv' }).expect(400);
  });

  it('la revisión de cartera solo abre casos por coincidencias nuevas', async () => {
    const t = await createTenant(ctx, { modules: ['plaft'] });
    const s = await post(t.key, '/v1/plaft/subjects', {
      relation: 'cliente', kind: 'individual', name: 'Carlos Mendoza Vela', doc_type: 'DNI', doc_number: '33334444', monitor: true,
    }).expect(201);
    await post(t.key, '/v1/plaft/subjects', {
      relation: 'cliente', kind: 'individual', name: 'Carlos Mendoza Sin Monitoreo', doc_type: 'DNI', doc_number: '33335555', monitor: false,
    }).expect(201);
    expect(s.body.case_id).toBeNull();

    hits.set('CARLOS MENDOZA', [match('A1')]);
    const r1 = await post(t.key, '/v1/plaft/rescreen', {}).expect(201);
    expect(r1.body).toEqual({ subjects: 1, with_matches: 1, new_matches: 1, cases_opened: 1 });
    const r2 = await post(t.key, '/v1/plaft/rescreen', {}).expect(201);
    expect(r2.body).toMatchObject({ with_matches: 1, new_matches: 0, cases_opened: 0 });

    hits.set('CARLOS MENDOZA', [match('A1'), match('B2', 'pep', 'pep_pe')]);
    const r3 = await post(t.key, '/v1/plaft/rescreen', {}).expect(201);
    expect(r3.body).toMatchObject({ new_matches: 1, cases_opened: 1 });
    const cases = (await get(t.key, '/v1/plaft/cases')).body.items;
    expect(cases).toHaveLength(2);
    const latest = await get(t.key, `/v1/plaft/cases/${cases[0].id}`).expect(200);
    expect(latest.body.matches.map((m: any) => m.entry_id)).toEqual(['B2']);
    expect(latest.body.origin).toBe('rescreen');
    const subject = await get(t.key, `/v1/plaft/subjects/${s.body.subject.id}`).expect(200);
    expect(subject.body.regime).toBe('reforzado');
    expect(subject.body.screenings.map((x: any) => x.kind)).toEqual(['rescreen', 'rescreen', 'rescreen', 'onboarding']);
  });

  it('listas: carga manual y sincronización llaman al motor y revisan carteras', async () => {
    const t = await createTenant(ctx, { modules: ['plaft'] });
    await post(t.key, '/v1/plaft/subjects', {
      relation: 'accionista', kind: 'individual', name: 'Lucía Paredes', doc_type: 'DNI', doc_number: '55556666', monitor: true,
    }).expect(201);
    const put = (path: string, body: Buffer, token = ctx.config.adminToken) =>
      ctx.http().put(path).set('x-admin-token', token).set('content-type', 'application/x-ndjson').send(body);
    const jsonl = Buffer.from('{"id":"p1","name":"Lucía Paredes","kind":"individual"}\n');
    await put('/admin/plaft/watchlists/pep_pe?format=ukuk_jsonl&category=pep', jsonl, 'malo').expect(401);
    await put('/admin/plaft/watchlists/PEP?format=ukuk_jsonl', jsonl).expect(400);
    await put('/admin/plaft/watchlists/pep_pe?format=pdf', jsonl).expect(400);
    const loaded = await put('/admin/plaft/watchlists/pep_pe?format=ukuk_jsonl&category=pep', jsonl).expect(200);
    expect(loaded.body).toMatchObject({ source: 'pep_pe', category: 'pep', changed: true, rescreen: null });
    const call = engine.calls.filter((c) => c.method === 'loadWatchlist').pop()!;
    expect(call.args).toEqual(['pep_pe', 'ukuk_jsonl', 'pep', jsonl.length]);

    hits.set('LUCIA PAREDES', [match('p1', 'pep', 'pep_pe')]);
    const sync = await ctx.admin('post', '/admin/plaft/watchlists/sync').expect(201);
    expect(fetched).toEqual(['https://example.test/sdn.csv', 'https://example.test/un.xml']);
    expect(sync.body.changed).toBe(true);
    expect(sync.body.results.map((r: any) => r.source)).toEqual(['ofac_sdn', 'un']);
    const mine = sync.body.rescreen.find((r: any) => r.tenant_id === t.id);
    expect(mine).toMatchObject({ subjects: 1, cases_opened: 1 });

    const versions = await ctx.admin('get', '/admin/plaft/watchlists').expect(200);
    expect(versions.body.map((v: any) => v.source).sort()).toEqual(['ofac_sdn', 'pep_pe', 'un']);
  });

  it('cobro mensual de registros monitoreados, idempotente', async () => {
    const t = await createTenant(ctx, { modules: ['plaft'] });
    for (const [doc, monitor] of [['66667777', true], ['66668888', true], ['66669999', false]] as const) {
      await post(t.key, '/v1/plaft/subjects', { relation: 'cliente', kind: 'individual', name: `Persona ${doc}`, doc_type: 'DNI', doc_number: doc, monitor }).expect(201);
    }
    await ctx.admin('post', '/admin/plaft/billing/monitored?month=2026-13').expect(400);
    const first = await ctx.admin('post', '/admin/plaft/billing/monitored?month=2026-09').expect(201);
    expect(first.body.find((r: any) => r.tenant_id === t.id)).toEqual({ tenant_id: t.id, month: '2026-09', monitored: 2, recorded: true });
    const second = await ctx.admin('post', '/admin/plaft/billing/monitored?month=2026-09').expect(201);
    expect(second.body.find((r: any) => r.tenant_id === t.id)).toMatchObject({ monitored: 2, recorded: false });
    const usage = await get(t.key, '/v1/account/usage?month=2026-09').expect(200);
    expect(usage.body.lines.find((l: any) => l.description === 'monitored_record_month').quantity).toBe(2);
  });

  it('informe para el oficial de cumplimiento', async () => {
    const t = await createTenant(ctx, { modules: ['plaft'] });
    hits.set('ALERTA', [match('Z9')]);
    await post(t.key, '/v1/plaft/subjects', { relation: 'cliente', kind: 'individual', name: 'Alerta Uno', doc_type: 'DNI', doc_number: '77778888', monitor: true }).expect(201);
    await post(t.key, '/v1/plaft/subjects', { relation: 'proveedor', kind: 'individual', name: 'Normal Dos', doc_type: 'DNI', doc_number: '77779999', monitor: true }).expect(201);
    const r = await get(t.key, '/v1/plaft/report').expect(200);
    expect(r.body.portfolio).toMatchObject({ total: 2, monitored: 2, by_relation: { cliente: 1, proveedor: 1 }, by_regime: { reforzado: 1, general: 1 } });
    expect(r.body.period).toMatchObject({ cases_opened: 1, matches_by_category: { sanction: 1 }, screenings_by_kind: { onboarding: 2 } });
    expect(r.body.open_cases).toBe(1);
    expect(r.body.reviews_due_30_days.count).toBe(0);
    await get(t.key, '/v1/plaft/report?from=2026-12-01&to=2026-01-01').expect(400);
  });
});

describe('PLAFT con noticias negativas juzgadas por Claude', () => {
  let ctx: TestContext;
  const llm = {
    enabled: true,
    async structured() {
      return { same_person: true, confidence: 0.9, reason: 'Mismo nombre, DNI y cargo mencionados.' };
    },
  };

  beforeAll(async () => {
    ctx = await createTestApp([
      { provide: (await import('../src/llm/llm.service')).LlmService, useValue: llm },
      {
        provide: ADVERSE_MEDIA_PROVIDER,
        useValue: {
          name: 'fake',
          search: async () => [
            { title: 'Fiscalía investiga a empresario', url: 'https://example.test/n1', source: 'example', published_at: null, snippet: '...' },
          ],
        },
      },
    ]);
  });
  afterAll(() => ctx.close());

  it('una noticia sobre la misma persona lleva a régimen reforzado', async () => {
    const t = await createTenant(ctx, { modules: ['plaft'] });
    const res = await ctx.http().post('/v1/plaft/subjects').set('x-api-key', t.key).send({
      relation: 'cliente', kind: 'individual', name: 'Jorge Salas', doc_type: 'DNI', doc_number: '10102020', monitor: true,
    }).expect(201);
    expect(res.body.screening.adverse_media).toMatchObject({ relevant: 1, needs_review: false });
    expect(res.body.screening.adverse_media.articles[0].judgment.same_person).toBe(true);
    expect(res.body.subject).toMatchObject({ regime: 'reforzado', risk_factors: ['noticias_negativas'] });
  });
});
