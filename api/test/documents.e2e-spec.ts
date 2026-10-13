import { randomBytes } from 'node:crypto';
import { OCR_PROVIDER } from '../src/documents/ocr/ocr.provider';
import { LlmService } from '../src/llm/llm.service';
import { FakeEngine, TestContext, createTenant, createTestApp } from './helpers';

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]);

class FakeOcr {
  readonly name = 'fake';
  words: any[] = [];
  async extract() {
    return this.words;
  }
}

const word = (text: string, x: number, y: number) => ({ text, confidence: 0.99, page: 1, bbox: { x, y, w: 0.1, h: 0.02 } });

describe('servicio documental', () => {
  let ctx: TestContext;
  const engine = new FakeEngine();
  const ocr = new FakeOcr();

  beforeAll(async () => {
    ctx = await createTestApp([
      { provide: (await import('../src/engine/engine.client')).EngineClient, useValue: engine },
      { provide: OCR_PROVIDER, useValue: ocr },
    ]);
  });
  afterAll(() => ctx.close());
  afterEach(() => {
    engine.analyzeImpl = undefined;
    ocr.words = [];
  });

  const upload = (key: string, data: Buffer, fields: Record<string, string> = {}, filename = 'foto.jpg') => {
    let req = ctx.http().post('/v1/documents').set('x-api-key', key).attach('file', data, { filename });
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req;
  };

  it('analiza, puntúa y devuelve el informe con hallazgos ubicados', async () => {
    const t = await createTenant(ctx, { modules: ['documents'] });
    engine.analyzeImpl = (req) => ({
      engine_version: 'fake-1',
      sha256: 'x',
      mime_type: req.mime_type,
      image: {
        width: 1000,
        height: 800,
        dhash: '0123456789abcdef',
        quality: { blur_variance: 500, brightness: 0.5, contrast: 0.2, glare_ratio: 0, megapixels: 0.8 },
        ela: { mean: 1, max: 40, suspicious_regions: 1 },
        exif: { software: 'Adobe Photoshop', has_gps: false },
      },
      mrz: {
        valid: true,
        document_type: 'I',
        issuing_state: 'PER',
        document_number: '12345678',
        birth_date: '1990-05-31',
        sex: 'M',
        expiry_date: '2030-01-01',
        nationality: 'PER',
        surnames: 'PEREZ GARCIA',
        given_names: 'JUAN CARLOS',
        checks: {},
      },
      findings: [
        {
          code: 'ela.suspicious_region',
          layer: 'forensics',
          severity: 'high',
          confidence: 1,
          message: 'Zona con compresión distinta',
          region: { page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
          evidence: { ela_max: 40 },
        },
      ],
      duration_ms: 5,
    });
    const res = await upload(t.key, jpeg(), { document_type: 'dni', level: 'forensic', external_ref: 'SIN-1' }).expect(201);
    expect(res.body).toMatchObject({
      status: 'completed',
      document_type: 'dni',
      score: 35,
      verdict: 'revisar',
      retake_required: false,
      confidence_note: 'sin plantilla de referencia, confianza limitada',
      engine_version: 'fake-1',
      template: null,
      external_ref: 'SIN-1',
    });
    const ela = res.body.findings.find((f: any) => f.code === 'ela.suspicious_region');
    expect(ela.region).toEqual({ page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
    expect(ela.evidence).toEqual({ ela_max: 40 });
    expect(res.body.extracted_fields).toMatchObject({ dni: '12345678', apellidos: 'PEREZ GARCIA' });
    // RENIEC sin convenio configurado: hallazgo informativo, con fecha y hora.
    const reniec = res.body.external.find((e: any) => e.source === 'reniec');
    expect(reniec.status).toBe('not_configured');
    expect(reniec.checked_at).toBeDefined();
    expect(res.body.findings.map((f: any) => f.code)).toContain('external.reniec_not_configured');
    expect(res.body.progress.map((p: any) => p.stage)).toEqual(['stored', 'ocr', 'engine', 'external', 'scored']);

    const again = await ctx.http().get(`/v1/documents/${res.body.id}`).set('x-api-key', t.key).expect(200);
    expect(again.body.score).toBe(35);
    const list = await ctx.http().get('/v1/documents?verdict=revisar').set('x-api-key', t.key).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].id).toBe(res.body.id);
    expect((await ctx.http().get('/v1/documents?verdict=aprobar').set('x-api-key', t.key)).body.total).toBe(0);

    const month = new Date().toISOString().slice(0, 7);
    const usage = await ctx.http().get(`/v1/account/usage?month=${month}`).set('x-api-key', t.key).expect(200);
    expect(usage.body.lines.find((l: any) => l.description === 'forensic').quantity).toBe(1);
  });

  it('detecta reuso: mismo archivo y misma imagen', async () => {
    const t = await createTenant(ctx, { modules: ['documents'] });
    const img = jpeg();
    const first = await upload(t.key, img).expect(201);
    expect(first.body.verdict).toBe('aprobar');
    const second = await upload(t.key, img).expect(201);
    const same = second.body.findings.find((f: any) => f.code === 'reuse.same_file');
    expect(same.severity).toBe('high');
    expect(same.evidence.prior_document_id).toBe(first.body.id);
    // Otro archivo con la misma huella perceptual (el motor falso devuelve el mismo dHash).
    const third = await upload(t.key, jpeg()).expect(201);
    const dup = third.body.findings.find((f: any) => f.code === 'reuse.duplicate_image');
    expect(dup.evidence.prior_document_id).toBe(first.body.id);
    expect(dup.evidence.hamming).toBe(0);
    expect(third.body.findings.some((f: any) => f.code === 'reuse.same_file')).toBe(false);
    // Otro cliente con la misma imagen no ve el historial ajeno.
    const other = await createTenant(ctx, { modules: ['documents'] });
    const o = await upload(other.key, img).expect(201);
    expect(o.body.findings.filter((f: any) => f.layer === 'reuse')).toEqual([]);
  });

  it('servicio no contratado → 403 y aislamiento entre clientes → 404', async () => {
    const noDocs = await createTenant(ctx, { modules: ['plaft'] });
    await upload(noDocs.key, jpeg()).expect(403);
    const a = await createTenant(ctx, { modules: ['documents'] });
    const b = await createTenant(ctx, { modules: ['documents'] });
    const img = jpeg();
    const doc = await upload(a.key, img, {}, 'boleta.jpg').expect(201);
    await ctx.http().get(`/v1/documents/${doc.body.id}`).set('x-api-key', b.key).expect(404);
    await ctx.http().get(`/v1/documents/${doc.body.id}/file`).set('x-api-key', b.key).expect(404);
    expect((await ctx.http().get('/v1/documents').set('x-api-key', b.key)).body.total).toBe(0);
    const file = await ctx.http().get(`/v1/documents/${doc.body.id}/file`).set('x-api-key', a.key).buffer(true).expect(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(file.body, img)).toBe(0);
  });

  it('formatos: HEIC pide otra foto, ZIP 422, desconocido 415, campos inválidos 400', async () => {
    const t = await createTenant(ctx, { modules: ['documents'] });
    const before = engine.calls.length;
    const heic = Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypheic', 'latin1'), randomBytes(32)]);
    const res = await upload(t.key, heic, {}, 'IMG_0001.HEIC').expect(201);
    expect(res.body).toMatchObject({ verdict: 'revisar', retake_required: true, mime_type: 'image/heic' });
    expect(res.body.findings[0].code).toBe('file.heic_unsupported');
    expect(engine.calls.length).toBe(before);
    await upload(t.key, Buffer.from('PK\x03\x04aaaa', 'latin1'), {}, 'lote.zip').expect(422);
    await upload(t.key, Buffer.from('hola'), {}, 'a.txt').expect(415);
    await upload(t.key, jpeg(), { fields: '[1,2]' }).expect(400);
    await upload(t.key, jpeg(), { level: 'premium' }).expect(400);
    await ctx.http().post('/v1/documents').set('x-api-key', t.key).field('level', 'verification').expect(400);
  });

  it('factura: valida RUC con el motor y avisa que SUNAT no está configurado', async () => {
    const t = await createTenant(ctx, { modules: ['documents'] });
    const fields = { ruc_emisor: '99100047218', serie_numero: 'F001-00001234', fecha_emision: '2026-03-15', total: '118.00' };
    const res = await upload(t.key, Buffer.from('%PDF-1.7\n%%EOF'), { document_type: 'factura', fields: JSON.stringify(fields) }, 'f.pdf').expect(201);
    const codes = res.body.findings.map((f: any) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['external.sunat_not_configured', 'ruc.invalid']));
    expect(res.body.external.find((e: any) => e.source === 'ruc').response).toMatchObject({ valid: false });
    expect(res.body.issuer).toBe('99100047218');
  });

  it('revisión del analista auditada y biblioteca de plantillas desde muestras', async () => {
    const t = await createTenant(ctx, { modules: ['documents'] });
    engine.analyzeImpl = (req) => ({
      engine_version: 'fake',
      sha256: 'x',
      mime_type: req.mime_type,
      image: null,
      findings: [],
      duration_ms: 1,
    });
    const ids: string[] = [];
    for (const dx of [0, 0.005, 0.01]) {
      ocr.words = [word('CLINICA', 0.1 + dx, 0.05), word('RUC', 0.6, 0.05 + dx), word('Paciente' + dx, 0.2, 0.5)];
      const r = await upload(t.key, jpeg(), {
        document_type: 'boleta_venta',
        issuer: 'Clínica Sol',
        fields: JSON.stringify({ fecha_emision: '2024-05-01' }),
      }).expect(201);
      ids.push(r.body.id);
    }
    const rev = await ctx
      .http()
      .post(`/v1/documents/${ids[0]}/review`)
      .set('x-api-key', t.key)
      .send({ decision: 'legitimo', notes: 'Confirmado con la clínica', analyst: 'ana', add_to_templates: true })
      .expect(201);
    expect(rev.body).toMatchObject({ template_sample: true, template_samples: 1 });
    for (const id of ids.slice(1)) {
      await ctx.http().post(`/v1/documents/${id}/review`).set('x-api-key', t.key).send({ decision: 'legitimo', add_to_templates: true }).expect(201);
    }
    await ctx.http().post(`/v1/documents/${ids[0]}/review`).set('x-api-key', t.key).send({ decision: 'rechazado', add_to_templates: true }).expect(422);
    await ctx.http().post(`/v1/documents/${ids[0]}/review`).set('x-api-key', t.key).send({ decision: 'quizas' }).expect(400);

    const audit = await ctx.http().get(`/v1/account/audit?entity=document&entity_id=${ids[0]}`).set('x-api-key', t.key).expect(200);
    const reviewed = audit.body.find((e: any) => e.action === 'document.reviewed');
    expect(reviewed).toMatchObject({ actor: 'analyst:ana', data: { decision: 'legitimo' } });
    expect((await ctx.http().get('/v1/account/audit/verify').set('x-api-key', t.key)).body.ok).toBe(true);

    const tpl = await ctx
      .http()
      .post('/v1/documents/templates/from-samples')
      .set('x-api-key', t.key)
      .send({ document_type: 'boleta_venta', issuer: 'Clínica Sol', version_label: 'formato 2', valid_from: '2023-03-01' })
      .expect(201);
    expect(tpl.body.anchors.map((a: any) => a.text).sort()).toEqual(['CLINICA', 'RUC']);
    expect(tpl.body).toMatchObject({ issuer: 'clínica sol', sample_count: 3, valid_from: '2023-03-01', valid_to: null });

    // Una plantilla antigua que no cubre la fecha del documento no se usa.
    await ctx
      .http()
      .post('/v1/documents/templates')
      .set('x-api-key', t.key)
      .send({
        document_type: 'boleta_venta',
        issuer: 'Clínica Sol',
        version_label: 'formato 1',
        valid_from: '2020-01-01',
        valid_to: '2023-02-28',
        anchors: [{ text: 'CLINICA', bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.02 } }],
      })
      .expect(201);
    const list = await ctx.http().get('/v1/documents/templates?issuer=Clínica Sol').set('x-api-key', t.key).expect(200);
    expect(list.body).toHaveLength(2);

    ocr.words = [word('CLINICA', 0.1, 0.05)];
    const checked = await upload(t.key, jpeg(), {
      document_type: 'boleta_venta',
      issuer: 'clínica sol',
      fields: JSON.stringify({ fecha_emision: '2026-01-10' }),
    }).expect(201);
    expect(checked.body.template).toEqual({ id: tpl.body.id, label: expect.stringContaining('formato 2') });
    expect(checked.body.confidence_note).toBeNull();
    const call = engine.calls.filter((c) => c.method === 'analyze').pop()!.args[0] as any;
    expect(call.template.anchors).toHaveLength(2);
    expect(call.ocr_words).toHaveLength(1);

    const old = await upload(t.key, jpeg(), {
      document_type: 'boleta_venta',
      issuer: 'clínica sol',
      fields: JSON.stringify({ fecha_emision: '2021-06-01' }),
    }).expect(201);
    expect(old.body.template.label).toContain('formato 1');

    await ctx.http().delete(`/v1/documents/templates/${tpl.body.id}`).set('x-api-key', t.key).expect(200);
    await ctx.http().delete(`/v1/documents/templates/${tpl.body.id}`).set('x-api-key', t.key).expect(404);
    // El informe conserva qué plantilla se usó aunque luego se borre.
    const after = await ctx.http().get(`/v1/documents/${checked.body.id}`).set('x-api-key', t.key);
    expect(after.body.template).toEqual({ id: null, label: expect.stringContaining('formato 2') });
  });
});

describe('servicio documental con explicación de Claude', () => {
  let ctx: TestContext;
  const llm = {
    enabled: true,
    prompts: [] as string[],
    async structured(req: { prompt: string }) {
      this.prompts.push(req.prompt);
      return { summary: 'Hay una zona editada.', per_finding: [{ code: 'ela.x', explanation: 'Compresión distinta.' }] };
    },
  };

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: LlmService, useValue: llm }]);
  });
  afterAll(() => ctx.close());

  it('guarda la explicación sin cambiar puntaje ni veredicto', async () => {
    const t = await createTenant(ctx, { modules: ['documents'] });
    const res = await ctx.http().post('/v1/documents').set('x-api-key', t.key).attach('file', jpeg(), { filename: 'a.jpg' }).expect(201);
    expect(res.body.explanation.summary).toBe('Hay una zona editada.');
    expect(res.body).toMatchObject({ score: 0, verdict: 'aprobar' });
    expect(llm.prompts[0]).toContain('"puntaje": 0');
  });
});
