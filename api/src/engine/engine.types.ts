// Espejo de docs/contrato-motor.md. Mantener sincronizado con el motor Rust.

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type Layer =
  | 'quality'
  | 'classification'
  | 'extraction'
  | 'consistency'
  | 'forensics'
  | 'template'
  | 'external'
  | 'reuse';

export interface Region {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Finding {
  code: string;
  layer: Layer;
  severity: Severity;
  confidence: number;
  message: string;
  region?: Region | null;
  evidence?: Record<string, unknown> | null;
}

export interface OcrWord {
  text: string;
  confidence: number;
  page: number;
  bbox: { x: number; y: number; w: number; h: number };
}

export type DocumentType =
  | 'dni'
  | 'boleta_pago'
  | 'recibo_servicio'
  | 'factura'
  | 'boleta_venta'
  | 'informe_medico'
  | 'receta'
  | 'acta'
  | 'certificado'
  | 'other';

export interface TemplateProfile {
  id: string;
  label: string;
  anchors: { text: string; bbox: { x: number; y: number; w: number; h: number } }[];
  tolerance?: number;
}

export interface AnalyzeRequest {
  file_base64: string;
  mime_type: string;
  document_type?: DocumentType;
  ocr_words?: OcrWord[];
  fields?: Record<string, string>;
  template?: TemplateProfile;
}

export interface MrzResult {
  valid: boolean;
  document_type: string;
  issuing_state: string;
  document_number: string;
  birth_date: string | null;
  sex: string;
  expiry_date: string | null;
  nationality: string;
  surnames: string;
  given_names: string;
  checks: Record<string, boolean>;
}

export interface AnalyzeResponse {
  engine_version: string;
  sha256: string;
  mime_type: string;
  image?: {
    width: number;
    height: number;
    dhash: string;
    quality: { blur_variance: number; brightness: number; contrast: number; glare_ratio: number; megapixels: number };
    ela: { mean: number; max: number; suspicious_regions: number };
    exif?: { software?: string; make?: string; model?: string; datetime_original?: string; has_gps: boolean } | null;
  } | null;
  pdf?: {
    version?: string;
    pages?: number;
    producer?: string;
    creator?: string;
    creation_date?: string;
    mod_date?: string;
    incremental_updates: number;
    encrypted: boolean;
    has_javascript: boolean;
    has_text_layer: boolean;
    fonts: string[];
  } | null;
  xml?: {
    is_sunat_ubl: boolean;
    has_signature: boolean;
    ruc_emisor?: string;
    serie_numero?: string;
    total?: string;
    fecha_emision?: string;
  } | null;
  mrz?: MrzResult | null;
  findings: Finding[];
  duration_ms: number;
}

export type WatchlistFormat = 'ofac_sdn_csv' | 'un_xml' | 'ukuk_jsonl';
export type WatchlistCategory = 'sanction' | 'pep' | 'interest';

export interface WatchlistInfo {
  source: string;
  category: WatchlistCategory;
  entries: number;
  version: string;
  loaded_at: string;
}

export interface ScreenRequest {
  name: string;
  kind?: 'individual' | 'entity';
  birth_date?: string;
  nationality?: string;
  threshold?: number;
  sources?: string[];
  limit?: number;
}

export interface ScreenMatch {
  source: string;
  category: WatchlistCategory;
  entry_id: string;
  name: string;
  matched_name: string;
  score: number;
  kind: string;
  programs: string[];
  birth_dates: string[];
  nationalities: string[];
  reasons: string[];
}

export interface ScreenResponse {
  query_normalized: string;
  matches: ScreenMatch[];
}

export interface BatchScreenRequest {
  subjects: ({ ref: string } & Omit<ScreenRequest, 'threshold' | 'sources' | 'limit'>)[];
  threshold?: number;
}

export interface BatchScreenResponse {
  results: { ref: string; matches: ScreenMatch[] }[];
}
