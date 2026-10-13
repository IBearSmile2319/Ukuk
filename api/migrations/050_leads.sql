-- Interesados que piden un piloto desde la página pública. Tabla global (sin cliente).
CREATE TABLE leads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  name         text NOT NULL,
  company      text NOT NULL,
  email        text NOT NULL,
  phone        text,
  entity_type  text,
  services     text[] NOT NULL DEFAULT '{}',
  message      text
);
GRANT SELECT, INSERT ON leads TO ukuk_app;
