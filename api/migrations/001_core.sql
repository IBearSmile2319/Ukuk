-- Núcleo multicliente: clientes, llaves de API, auditoría inalterable, uso y archivos.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ukuk_app') THEN
    CREATE ROLE ukuk_app LOGIN PASSWORD 'ukuk';
  END IF;
END $$;

-- Activa RLS forzada sobre una tabla con columna tenant_id y da permisos al rol de la app.
CREATE OR REPLACE FUNCTION ukuk_tenant_table(tbl regclass) RETURNS void AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
    'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', tbl);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO ukuk_app', tbl);
END $$ LANGUAGE plpgsql;

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  ruc           text,
  entity_type   text NOT NULL DEFAULT 'otro',
  business_lines text[] NOT NULL DEFAULT '{}',
  modules       text[] NOT NULL DEFAULT '{}',
  data_key_enc  bytea NOT NULL,
  status        text NOT NULL DEFAULT 'active',
  settings      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON tenants TO ukuk_app;

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         text NOT NULL,
  key_prefix   text NOT NULL,
  key_hash     bytea NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
GRANT SELECT, INSERT, UPDATE ON api_keys TO ukuk_app;

-- Registro de auditoría encadenado por hash: cada fila incluye el hash de la anterior
-- del mismo cliente. UPDATE y DELETE están bloqueados por trigger.
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  data       jsonb NOT NULL DEFAULT '{}',
  prev_hash  bytea,
  hash       bytea NOT NULL
);
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, id);
SELECT ukuk_tenant_table('audit_log');
GRANT USAGE ON SEQUENCE audit_log_id_seq TO ukuk_app;

CREATE OR REPLACE FUNCTION ukuk_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es de solo inserción';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION ukuk_audit_immutable();

CREATE TABLE usage_events (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  at         timestamptz NOT NULL DEFAULT now(),
  service    text NOT NULL,
  unit       text NOT NULL,
  quantity   numeric NOT NULL DEFAULT 1,
  ref        text
);
CREATE INDEX usage_events_tenant_at_idx ON usage_events (tenant_id, at);
SELECT ukuk_tenant_table('usage_events');
GRANT USAGE ON SEQUENCE usage_events_id_seq TO ukuk_app;

-- Archivos cifrados con la llave de datos del cliente. El contenido vive en el BlobStore.
CREATE TABLE blobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  sha256       text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  filename     text,
  storage_key  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX blobs_tenant_sha_idx ON blobs (tenant_id, sha256);
SELECT ukuk_tenant_table('blobs');
