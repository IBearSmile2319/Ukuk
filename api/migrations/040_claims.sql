-- Servicio 4 — Siniestros por WhatsApp.

-- Tabla global de ruteo: el webhook llega sin cliente y se resuelve por phone_number_id.
-- El token de acceso se guarda cifrado con la llave de datos del cliente (o como
-- referencia al nombre de un secreto del entorno).
CREATE TABLE wa_numbers (
  phone_number_id  text PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  display_number   text NOT NULL,
  access_token_enc bytea,
  secret_ref       text,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wa_numbers_tenant_idx ON wa_numbers (tenant_id);
GRANT SELECT, INSERT, UPDATE ON wa_numbers TO ukuk_app;

-- Configuración del servicio por cliente (tipos de siniestro, destino, fuente de pólizas).
CREATE TABLE claim_settings (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id),
  config      jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);
SELECT ukuk_tenant_table('claim_settings');

-- Archivo diario de pólizas que carga el cliente (CsvPolicyProvider).
CREATE TABLE claim_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  policy_number text NOT NULL,
  holder_dni    text,
  holder_name   text NOT NULL,
  plate         text,
  product       text,
  line          text NOT NULL CHECK (line IN ('daños','personas')),
  start_date    date,
  end_date      date,
  notice_days   int,
  status        text NOT NULL DEFAULT 'vigente',
  imported_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, policy_number)
);
CREATE INDEX claim_policies_dni_idx ON claim_policies (tenant_id, holder_dni);
CREATE INDEX claim_policies_plate_idx ON claim_policies (tenant_id, plate);
SELECT ukuk_tenant_table('claim_policies');

CREATE TABLE claim_conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  phone_number_id  text NOT NULL,
  wa_id            text NOT NULL,
  profile_name     text,
  state            jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','handoff','closed')),
  claim_id         uuid,
  message_count    int NOT NULL DEFAULT 0,
  first_message_at timestamptz NOT NULL DEFAULT now(),
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_conversations_wa_idx ON claim_conversations (tenant_id, wa_id, last_message_at DESC);
SELECT ukuk_tenant_table('claim_conversations');

CREATE TABLE claims (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL REFERENCES tenants(id),
  number                     text NOT NULL,
  conversation_id            uuid REFERENCES claim_conversations(id),
  wa_id                      text,
  status                     text NOT NULL DEFAULT 'borrador' CHECK (status IN (
                               'borrador','cancelado','revision_analista','ajustador','aclaracion',
                               'aprobado','rechazado','consentido')),
  policy_number              text,
  holder_dni                 text,
  holder_name                text,
  claim_type                 text,
  line                       text,
  policy                     jsonb NOT NULL DEFAULT '{}',
  occurred_at                timestamptz,
  first_contact_at           timestamptz NOT NULL,
  location                   jsonb,
  narrative                  text,
  missing_docs               text[] NOT NULL DEFAULT '{}',
  docs_complete_at           timestamptz,
  -- Plazos calculados (se recalculan al leer y en el barrido horario).
  notice_deadline            timestamptz,
  late_notice                boolean NOT NULL DEFAULT false,
  clarification_cutoff       timestamptz,
  consent_deadline           timestamptz,
  payment_deadline           timestamptz,
  risk_level                 text NOT NULL DEFAULT 'bajo' CHECK (risk_level IN ('bajo','medio','alto')),
  risk_score                 int NOT NULL DEFAULT 0,
  risk_reasons               jsonb NOT NULL DEFAULT '[]',
  requires_analyst_review    boolean NOT NULL DEFAULT false,
  review_action              text,
  review_note                text,
  decision                   text,
  decision_note              text,
  decided_at                 timestamptz,
  clarification_requested_at timestamptz,
  consented_at               timestamptz,
  dispatched_at              timestamptz,
  submitted_at               timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX claims_status_idx ON claims (tenant_id, status, consent_deadline);
SELECT ukuk_tenant_table('claims');

-- Transcripción (entrantes y salientes).
CREATE TABLE claim_messages (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL REFERENCES claim_conversations(id),
  direction       text NOT NULL CHECK (direction IN ('in','out')),
  wamid           text,
  type            text NOT NULL,
  body            text,
  payload         jsonb NOT NULL DEFAULT '{}',
  file_id         uuid,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_messages_conv_idx ON claim_messages (tenant_id, conversation_id, id);
SELECT ukuk_tenant_table('claim_messages');
GRANT USAGE ON SEQUENCE claim_messages_id_seq TO ukuk_app;

-- Idempotencia del webhook: Meta reintenta y puede repetir mensajes.
CREATE TABLE wa_message_ids (
  wamid       text PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  received_at timestamptz NOT NULL DEFAULT now()
);
SELECT ukuk_tenant_table('wa_message_ids');

-- Fotos, documentos y audios del caso, con el resultado del motor.
CREATE TABLE claim_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  claim_id        uuid REFERENCES claims(id),
  conversation_id uuid REFERENCES claim_conversations(id),
  blob_id         uuid NOT NULL REFERENCES blobs(id),
  kind            text NOT NULL CHECK (kind IN ('photo','document','audio','video')),
  source          text NOT NULL CHECK (source IN ('whatsapp','capture')),
  doc_type        text,
  mime_type       text NOT NULL,
  sha256          text NOT NULL,
  dhash           text,
  analysis        jsonb,
  findings        jsonb NOT NULL DEFAULT '[]',
  capture         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_files_claim_idx ON claim_files (tenant_id, claim_id);
CREATE INDEX claim_files_sha_idx ON claim_files (tenant_id, sha256);
SELECT ukuk_tenant_table('claim_files');

CREATE TABLE claim_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  claim_id    uuid NOT NULL REFERENCES claims(id),
  kind        text NOT NULL,
  message     text NOT NULL,
  due_at      timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, claim_id, kind)
);
SELECT ukuk_tenant_table('claim_alerts');
