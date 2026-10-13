-- Servicio 2 — Radar regulatorio.
-- Las normas son globales (se ingieren una sola vez para todos los clientes); el
-- inventario de procesos, los impactos y las tareas son de cada cliente (RLS).

CREATE TABLE reg_norms (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source            text NOT NULL CHECK (source IN ('el_peruano','sbs','smv','bcrp','uif','susalud','indecopi')),
  external_id       text NOT NULL,
  issuer            text,
  number            text,
  title             text NOT NULL,
  summary           text,
  published_at      date NOT NULL,
  effective_at      date,
  url               text,
  pdf_url           text,
  text              text,
  scope             text NOT NULL DEFAULT 'general' CHECK (scope IN ('general','particular')),
  status            text NOT NULL DEFAULT 'vigente' CHECK (status IN ('vigente','proyecto')),
  comments_deadline date,
  entity_types      text[] NOT NULL DEFAULT '{}',
  topics            text[] NOT NULL DEFAULT '{}',
  articles          jsonb NOT NULL DEFAULT '[]',
  -- método (reglas|llm), confianza, obligaciones y frase de vigencia detectadas.
  classification    jsonb NOT NULL DEFAULT '{}',
  search            tsvector GENERATED ALWAYS AS (
    to_tsvector('spanish', coalesce(number, '') || ' ' || title || ' ' || coalesce(summary, '') || ' ' || coalesce(text, ''))
  ) STORED,
  ingested_at       timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX reg_norms_published_idx ON reg_norms (published_at DESC);
CREATE INDEX reg_norms_search_idx ON reg_norms USING gin (search);
CREATE INDEX reg_norms_topics_idx ON reg_norms USING gin (topics);
GRANT SELECT, INSERT, UPDATE ON reg_norms TO ukuk_app;

-- Inventario de políticas, procesos y manuales del cliente.
CREATE TABLE reg_processes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  code         text NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('politica','proceso','manual','procedimiento')),
  description  text NOT NULL DEFAULT '',
  owner_email  text,
  topics       text[] NOT NULL DEFAULT '{}',
  keywords     text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
SELECT ukuk_tenant_table('reg_processes');

-- Norma × proceso afectado.
CREATE TABLE reg_impacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  norm_id          uuid NOT NULL REFERENCES reg_norms(id),
  process_id       uuid NOT NULL REFERENCES reg_processes(id) ON DELETE CASCADE,
  score            real NOT NULL,
  matched_articles jsonb NOT NULL DEFAULT '[]',
  rationale        text NOT NULL DEFAULT '',
  method           text NOT NULL DEFAULT 'reglas',
  effective_at     date,
  status           text NOT NULL DEFAULT 'pendiente'
                   CHECK (status IN ('pendiente','no_aplica','en_adecuacion','adecuado')),
  status_note      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, norm_id, process_id)
);
CREATE INDEX reg_impacts_norm_idx ON reg_impacts (tenant_id, norm_id);
SELECT ukuk_tenant_table('reg_impacts');

CREATE TABLE reg_tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  impact_id         uuid NOT NULL REFERENCES reg_impacts(id) ON DELETE CASCADE,
  title             text NOT NULL,
  responsible_email text NOT NULL,
  due_at            date NOT NULL,
  status            text NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta','en_progreso','cerrada')),
  closed_at         timestamptz,
  evidence          text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reg_tasks_due_idx ON reg_tasks (tenant_id, status, due_at);
SELECT ukuk_tenant_table('reg_tasks');
