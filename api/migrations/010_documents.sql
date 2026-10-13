-- Servicio 1: verificación documental. Documentos analizados y biblioteca de plantillas.

-- Perfil de un emisor y versión: "boleta electrónica, Clínica X, formato 2, de 2023-03 a hoy".
CREATE TABLE document_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  document_type  text NOT NULL,
  issuer         text NOT NULL,          -- RUC o nombre normalizado (minúsculas)
  version_label  text NOT NULL,
  valid_from     date NOT NULL,
  valid_to       date,                   -- NULL = vigente
  anchors        jsonb NOT NULL DEFAULT '[]',
  tolerance      real NOT NULL DEFAULT 0.03,
  sample_count   int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX document_templates_lookup_idx ON document_templates (tenant_id, document_type, issuer, valid_from);
SELECT ukuk_tenant_table('document_templates');

CREATE TABLE documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  blob_id          uuid NOT NULL REFERENCES blobs(id),
  sha256           text NOT NULL,
  mime_type        text NOT NULL,
  filename         text,
  document_type    text,
  issuer           text,
  level            text NOT NULL,         -- extraction | verification | forensic (facturación)
  external_ref     text,
  status           text NOT NULL DEFAULT 'processing',  -- processing | completed | failed
  dhash            bigint,                -- huella perceptual de 64 bits (con signo)
  score            int,
  verdict          text,                  -- aprobar | revisar | rechazar
  retake_required  boolean NOT NULL DEFAULT false,
  confidence_note  text,
  findings         jsonb NOT NULL DEFAULT '[]',
  provided_fields  jsonb NOT NULL DEFAULT '{}',
  extracted        jsonb NOT NULL DEFAULT '{}',
  measurements     jsonb NOT NULL DEFAULT '{}',
  external         jsonb NOT NULL DEFAULT '[]',
  ocr_provider     text,
  ocr_words        jsonb,
  template_id      uuid REFERENCES document_templates(id) ON DELETE SET NULL,
  template_label   text,
  engine_version   text,
  explanation      jsonb,
  progress         jsonb NOT NULL DEFAULT '[]',
  error            text,
  review           jsonb,
  template_sample  boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX documents_tenant_created_idx ON documents (tenant_id, created_at DESC);
CREATE INDEX documents_tenant_sha_idx ON documents (tenant_id, sha256);
CREATE INDEX documents_tenant_dhash_idx ON documents (tenant_id) WHERE dhash IS NOT NULL;
SELECT ukuk_tenant_table('documents');
