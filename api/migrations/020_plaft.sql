-- Servicio 3: PLAFT. Sujetos a revisar, revisiones contra listas, coincidencias y casos.

CREATE TABLE plaft_subjects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  relation         text NOT NULL,   -- cliente | proveedor | trabajador | director | accionista
  kind             text NOT NULL,   -- individual | entity
  name             text NOT NULL,
  doc_type         text NOT NULL,   -- DNI | CE | RUC | PASAPORTE
  doc_number       text NOT NULL,
  birth_date       date,
  nationality      text,
  monitor          boolean NOT NULL DEFAULT true,
  regime           text NOT NULL DEFAULT 'general',  -- simplificado | general | reforzado
  risk_factors     jsonb NOT NULL DEFAULT '[]',
  dd_at            timestamptz NOT NULL DEFAULT now(),  -- última debida diligencia
  next_review_at   timestamptz,
  last_screened_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, relation, doc_type, doc_number)
);
CREATE INDEX plaft_subjects_monitor_idx ON plaft_subjects (tenant_id) WHERE monitor;
CREATE INDEX plaft_subjects_review_idx ON plaft_subjects (tenant_id, next_review_at);
SELECT ukuk_tenant_table('plaft_subjects');

CREATE TABLE plaft_screenings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  subject_id       uuid NOT NULL REFERENCES plaft_subjects(id),
  kind             text NOT NULL,   -- onboarding | bulk | rescreen
  threshold        real NOT NULL,
  query_normalized text,
  matches          jsonb NOT NULL DEFAULT '[]',
  new_matches      int NOT NULL DEFAULT 0,
  adverse_media    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plaft_screenings_subject_idx ON plaft_screenings (tenant_id, subject_id, created_at DESC);
SELECT ukuk_tenant_table('plaft_screenings');

CREATE TABLE plaft_cases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  subject_id   uuid NOT NULL REFERENCES plaft_subjects(id),
  screening_id uuid REFERENCES plaft_screenings(id),
  status       text NOT NULL DEFAULT 'abierto',   -- abierto | cerrado
  origin       text NOT NULL,                     -- onboarding | bulk | rescreen
  decision     text,                              -- falso_positivo | coincidencia_confirmada | escalado_uif
  rationale    text,
  decided_by   text,
  decided_at   timestamptz,
  ros_draft    boolean NOT NULL DEFAULT false,    -- borrador de Reporte de Operación Sospechosa
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plaft_cases_status_idx ON plaft_cases (tenant_id, status, created_at DESC);
SELECT ukuk_tenant_table('plaft_cases');

-- Una coincidencia (fuente + entrada de la lista) por sujeto: así la revisión nocturna
-- solo abre casos por coincidencias nuevas.
CREATE TABLE plaft_matches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  subject_id   uuid NOT NULL REFERENCES plaft_subjects(id),
  screening_id uuid NOT NULL REFERENCES plaft_screenings(id),
  case_id      uuid REFERENCES plaft_cases(id),
  source       text NOT NULL,
  category     text NOT NULL,
  entry_id     text NOT NULL,
  matched_name text NOT NULL,
  score        real NOT NULL,
  status       text NOT NULL DEFAULT 'pendiente',  -- pendiente | descartada | confirmada
  data         jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_id, source, entry_id)
);
CREATE INDEX plaft_matches_case_idx ON plaft_matches (tenant_id, case_id);
SELECT ukuk_tenant_table('plaft_matches');

-- Línea de tiempo inalterable de cada caso (además del registro de auditoría).
CREATE TABLE plaft_case_events (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  case_id    uuid NOT NULL REFERENCES plaft_cases(id),
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  type       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX plaft_case_events_case_idx ON plaft_case_events (tenant_id, case_id, id);
SELECT ukuk_tenant_table('plaft_case_events');
GRANT USAGE ON SEQUENCE plaft_case_events_id_seq TO ukuk_app;

CREATE OR REPLACE FUNCTION ukuk_case_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'plaft_case_events es de solo inserción';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER plaft_case_events_no_update BEFORE UPDATE OR DELETE ON plaft_case_events
  FOR EACH ROW EXECUTE FUNCTION ukuk_case_events_immutable();

-- Cobro mensual de registros monitoreados: una fila por cliente y mes (idempotencia).
CREATE TABLE plaft_billing_runs (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  month      text NOT NULL,   -- YYYY-MM
  monitored  int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, month)
);
SELECT ukuk_tenant_table('plaft_billing_runs');

-- Versiones de las listas públicas cargadas en el motor. Es global (no hay datos de
-- clientes), así que no lleva RLS.
CREATE TABLE watchlist_versions (
  id         bigserial PRIMARY KEY,
  source     text NOT NULL,
  category   text NOT NULL,
  format     text NOT NULL,
  version    text NOT NULL,
  entries    int NOT NULL,
  changed    boolean NOT NULL,
  loaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watchlist_versions_source_idx ON watchlist_versions (source, id DESC);
GRANT SELECT, INSERT ON watchlist_versions TO ukuk_app;
GRANT USAGE ON SEQUENCE watchlist_versions_id_seq TO ukuk_app;
