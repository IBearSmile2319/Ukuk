import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { AppConfig, loadConfig } from '../src/config/config';
import { migrate } from '../src/db/migrate';
import { EngineClient } from '../src/engine/engine.client';
import { LlmService } from '../src/llm/llm.service';

/** Servidor de PostgreSQL para pruebas (superusuario). */
export const PG_ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';

export interface TestContext {
  app: INestApplication;
  config: AppConfig;
  dbName: string;
  http: () => ReturnType<typeof request>;
  admin: (method: 'get' | 'post' | 'patch' | 'delete', path: string) => request.Test;
  close: () => Promise<void>;
}

/**
 * Levanta la app completa contra una base de datos nueva. La app se conecta como
 * ukuk_app (sin privilegios de superusuario) para que RLS se aplique de verdad.
 * `overrides` permite reemplazar el motor Rust, Claude u otros proveedores.
 */
export async function createTestApp(
  overrides: { provide: unknown; useValue: unknown }[] = [],
  configPatch: Partial<AppConfig> = {},
): Promise<TestContext> {
  const dbName = `ukuk_test_${randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const base = new URL(PG_ADMIN_URL);
  base.pathname = `/${dbName}`;
  await migrate(base.toString());
  const appUrl = new URL(base.toString());
  appUrl.username = 'ukuk_app';
  appUrl.password = 'ukuk';

  const config: AppConfig = {
    ...loadConfig({ NODE_ENV: 'test' }),
    databaseUrl: appUrl.toString(),
    storageDir: mkdtempSync(join(tmpdir(), 'ukuk-blobs-')),
    jobsEnabled: false,
    anthropicApiKey: undefined,
    ...configPatch,
  };

  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(config)] });
  const hasEngine = overrides.some((o) => o.provide === EngineClient);
  if (!hasEngine) builder = builder.overrideProvider(EngineClient).useValue(new FakeEngine());
  const hasLlm = overrides.some((o) => o.provide === LlmService);
  if (!hasLlm) builder = builder.overrideProvider(LlmService).useValue(new DisabledLlm());
  for (const o of overrides) builder = builder.overrideProvider(o.provide).useValue(o.useValue);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app);
  await app.init();

  return {
    app,
    config,
    dbName,
    http: () => request(app.getHttpServer()),
    admin: (method, path) => request(app.getHttpServer())[method](path).set('x-admin-token', config.adminToken),
    close: async () => {
      await app.close();
      const c = new Client({ connectionString: PG_ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await c.end();
    },
  };
}

/** Crea un cliente con los servicios indicados y devuelve su llave de API. */
export async function createTenant(
  ctx: TestContext,
  body: Record<string, unknown> = {},
): Promise<{ id: string; key: string }> {
  const t = await ctx
    .admin('post', '/admin/tenants')
    .send({ name: 'Aseguradora Prueba', entityType: 'aseguradora', modules: ['documents', 'regulatory', 'plaft', 'claims'], ...body })
    .expect(201);
  const k = await ctx.admin('post', `/admin/tenants/${t.body.id}/api-keys`).send({ name: 'test' }).expect(201);
  return { id: t.body.id, key: k.body.key };
}

export class DisabledLlm {
  readonly enabled = false;
  async structured() {
    return null;
  }
}

/**
 * Motor falso: mismas formas que docs/contrato-motor.md. Los tests pueden asignar
 * `analyzeImpl`, `screenImpl`, etc. para controlar la respuesta.
 */
export class FakeEngine {
  calls: { method: string; args: unknown[] }[] = [];
  analyzeImpl?: (req: any) => any;
  screenImpl?: (req: any) => any;
  watchlists: any[] = [];

  async health() {
    return { status: 'ok', version: 'fake' };
  }

  async analyze(req: any) {
    this.calls.push({ method: 'analyze', args: [req] });
    if (this.analyzeImpl) return this.analyzeImpl(req);
    const isImage = String(req.mime_type).startsWith('image/');
    return {
      engine_version: 'fake',
      sha256: 'fake',
      mime_type: req.mime_type,
      image: isImage
        ? {
            width: 1000,
            height: 800,
            dhash: 'f0f0f0f0f0f0f0f0',
            quality: { blur_variance: 500, brightness: 0.5, contrast: 0.2, glare_ratio: 0, megapixels: 0.8 },
            ela: { mean: 1, max: 5, suspicious_regions: 0 },
            exif: null,
          }
        : null,
      pdf: null,
      xml: null,
      mrz: null,
      findings: [],
      duration_ms: 1,
    };
  }

  async validateRuc(ruc: string) {
    return { valid: /^(10|15|16|17|20)\d{9}$/.test(ruc), kind: 'persona_juridica' };
  }

  async loadWatchlist(source: string, format: string, category: string, data: Buffer) {
    this.calls.push({ method: 'loadWatchlist', args: [source, format, category, data.length] });
    const info = { source, category, entries: 1, version: 'v' + this.watchlists.length, loaded_at: new Date().toISOString() };
    this.watchlists = [...this.watchlists.filter((w) => w.source !== source), info];
    return info;
  }

  async listWatchlists() {
    return this.watchlists;
  }

  async screen(req: any) {
    this.calls.push({ method: 'screen', args: [req] });
    if (this.screenImpl) return this.screenImpl(req);
    return { query_normalized: String(req.name).toUpperCase(), matches: [] };
  }

  async screenBatch(req: any) {
    this.calls.push({ method: 'screenBatch', args: [req] });
    const results = [];
    for (const s of req.subjects) {
      const r = await this.screen({ ...s, threshold: req.threshold });
      results.push({ ref: s.ref, matches: r.matches });
    }
    return { results };
  }
}
