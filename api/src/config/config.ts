export interface AppConfig {
  port: number;
  databaseUrl: string;
  engineUrl: string;
  /** Llave maestra local (32 bytes en base64). En producción la reemplaza KMS. */
  masterKey: Buffer;
  storageDir: string;
  /** Secreto para firmar enlaces públicos (página de captura, etc.). */
  linkSecret: string;
  publicBaseUrl: string;
  adminToken: string;
  anthropicApiKey?: string;
  whatsapp: {
    verifyToken?: string;
    appSecret?: string;
    accessToken?: string;
    graphUrl: string;
  };
  jobsEnabled: boolean;
}

function required(env: NodeJS.ProcessEnv, key: string, devDefault?: string): string {
  const value = env[key] ?? (env.NODE_ENV !== 'production' ? devDefault : undefined);
  if (!value) throw new Error(`Falta la variable de entorno ${key}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const masterKey = Buffer.from(
    required(env, 'UKUK_MASTER_KEY', Buffer.alloc(32, 7).toString('base64')),
    'base64',
  );
  if (masterKey.length !== 32) throw new Error('UKUK_MASTER_KEY debe tener 32 bytes en base64');
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: required(env, 'DATABASE_URL', 'postgres://ukuk_app:ukuk@localhost:5432/ukuk'),
    engineUrl: env.UKUK_ENGINE_URL ?? 'http://localhost:8090',
    masterKey,
    storageDir: env.UKUK_STORAGE_DIR ?? './var/blobs',
    linkSecret: required(env, 'UKUK_LINK_SECRET', 'dev-link-secret'),
    publicBaseUrl: env.UKUK_PUBLIC_BASE_URL ?? 'http://localhost:3000',
    adminToken: required(env, 'UKUK_ADMIN_TOKEN', 'dev-admin-token'),
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    whatsapp: {
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || undefined,
      appSecret: env.WHATSAPP_APP_SECRET || undefined,
      accessToken: env.WHATSAPP_ACCESS_TOKEN || undefined,
      graphUrl: env.WHATSAPP_GRAPH_URL ?? 'https://graph.facebook.com/v23.0',
    },
    jobsEnabled: env.UKUK_JOBS_ENABLED !== 'false',
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
