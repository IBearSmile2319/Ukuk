# Contrato HTTP del motor (`ukuk-engine`)

El motor es un servicio Rust **sin estado de cliente**: no sabe de tenants, no guarda
documentos y no habla con fuentes externas. Solo mide. La API (NestJS) orquesta,
persiste, aplica el aislamiento por cliente y combina los hallazgos con las
validaciones externas.

La única excepción de estado son las **listas de vigilancia** (OFAC, ONU, PEP…), que
el motor mantiene indexadas en memoria (y en disco en `UKUK_DATA_DIR`) porque son
públicas y compartidas por todos los clientes.

Todo el JSON va en `snake_case`. Errores: `{"error": "<codigo>", "message": "<texto>"}`
con 400 / 404 / 413 / 422 / 500.

## Tipos comunes

```jsonc
// Región normalizada (0..1) sobre la página o imagen.
Region { "page": 1, "x": 0.12, "y": 0.40, "w": 0.20, "h": 0.05 }

Finding {
  "code": "image.blur",            // namespace.punto: image.*, ela.*, copy_move.*, exif.*, pdf.*,
                                   // layout.*, mrz.*, ruc.*, invoice.*, dates.*, template.*, file.*
  "layer": "quality",              // quality | classification | extraction | consistency |
                                   // forensics | template | external | reuse
  "severity": "medium",            // info | low | medium | high | critical
  "confidence": 0.8,               // 0..1
  "message": "La imagen está borrosa…",   // español, para el informe
  "region": Region | null,
  "evidence": { … } | null         // mediciones crudas, para auditar
}

OcrWord { "text": "TOTAL", "confidence": 0.98, "page": 1,
          "bbox": { "x": 0.1, "y": 0.2, "w": 0.05, "h": 0.012 } }  // normalizado
```

## `GET /health`
`{"status":"ok","version":"0.1.0"}`

## `POST /v1/analyze`
Analiza un archivo y devuelve mediciones + hallazgos. Límite de cuerpo: 25 MB.

```jsonc
// request
{
  "file_base64": "...",
  "mime_type": "image/jpeg",       // image/jpeg|png|webp|tiff, application/pdf, application/xml, text/xml
  "document_type": "dni",          // opcional: dni | boleta_pago | recibo_servicio | factura |
                                   // boleta_venta | informe_medico | receta | acta | certificado | other
  "ocr_words": [OcrWord],          // opcional (la API los obtiene de Textract u otro OCR)
  "fields": {                      // opcional: datos impresos ya extraídos
    "dni": "12345678", "apellidos": "…", "nombres": "…",
    "fecha_nacimiento": "1990-05-31", "fecha_vencimiento": "2030-01-01", "sexo": "M",
    "mrz": "I<PER...\n...\n...",   // las 3 líneas TD1 separadas por \n
    "ruc_emisor": "20100047218", "serie_numero": "F001-00001234",
    "fecha_emision": "2026-03-15",
    "subtotal": "100.00", "igv": "18.00", "total": "118.00",
    "items_total": "100.00"
  },
  "template": {                    // opcional: perfil del emisor y versión que se espera
    "id": "uuid", "label": "Clínica X formato 2 (2023-03..)",
    "anchors": [ { "text": "RUC", "bbox": {"x":..,"y":..,"w":..,"h":..} } ],
    "tolerance": 0.03              // desplazamiento máximo normalizado
  }
}

// response
{
  "engine_version": "0.1.0",
  "sha256": "hex",
  "mime_type": "image/jpeg",
  "image": {                       // si es imagen
    "width": 1200, "height": 800,
    "dhash": "f0e1d2c3b4a59687",   // 64 bits en hex (16 chars)
    "quality": { "blur_variance": 812.3, "brightness": 0.55, "contrast": 0.21,
                 "glare_ratio": 0.01, "megapixels": 0.96 },
    "ela": { "mean": 2.1, "max": 40.0, "suspicious_regions": 1 },
    "exif": { "software": "Adobe Photoshop", "make": "...", "model": "...",
              "datetime_original": "...", "has_gps": false } | null
  } | null,
  "pdf": {                         // si es PDF (análisis estructural, sin renderizar)
    "version": "1.7", "pages": 2, "producer": "...", "creator": "...",
    "creation_date": "D:2026...", "mod_date": "D:2026...",
    "incremental_updates": 1, "encrypted": false, "has_javascript": false,
    "has_text_layer": true, "fonts": ["Helvetica", "ArialMT"]
  } | null,
  "xml": { "is_sunat_ubl": true, "has_signature": true, "ruc_emisor": "...",
           "serie_numero": "...", "total": "118.00", "fecha_emision": "..." } | null,
  "mrz": {
    "valid": true, "document_type": "I", "issuing_state": "PER",
    "document_number": "12345678", "birth_date": "1990-05-31", "sex": "M",
    "expiry_date": "2030-01-01", "nationality": "PER",
    "surnames": "PEREZ GARCIA", "given_names": "JUAN CARLOS",
    "checks": { "document_number": true, "birth_date": true, "expiry_date": true, "composite": true }
  } | null,
  "findings": [Finding],
  "duration_ms": 123
}
```

## `POST /v1/rules/ruc` → `{"ruc":"20100047218"}` → `{"valid":true,"kind":"persona_juridica"}`
`kind`: `persona_natural` (10), `persona_juridica` (20), `no_domiciliado` (15/16/17), `desconocido`.

## `POST /v1/rules/mrz` → `{"mrz":"línea1\nlínea2\nlínea3"}` → el objeto `mrz` de arriba + `findings`.

## Listas de vigilancia

### `PUT /v1/watchlists/{source}?format={fmt}&category={cat}`
Cuerpo crudo (el archivo tal cual). `fmt`: `ofac_sdn_csv` | `un_xml` | `ukuk_jsonl`.
`category`: `sanction` | `pep` | `interest` (por defecto `sanction`).
`{source}`: identificador libre, `[a-z0-9_-]{1,40}` (p. ej. `ofac_sdn`, `un`, `pep_pe`).

`ukuk_jsonl`: una entrada por línea:
`{"id":"…","name":"…","aliases":["…"],"kind":"individual|entity","birth_dates":["1960-01-01"],"nationalities":["PE"],"programs":["…"],"remarks":"…"}`

Respuesta: `{"source":"ofac_sdn","category":"sanction","entries":18234,"version":"<sha256>","loaded_at":"RFC3339"}`

### `GET /v1/watchlists` → `[{source, category, entries, version, loaded_at}]`

### `DELETE /v1/watchlists/{source}` → 204

### `POST /v1/screen`
```jsonc
// request
{ "name": "Juan Carlos Pérez de la Cruz", "kind": "individual",  // opcional
  "birth_date": "1970-02-03", "nationality": "PE",                 // opcionales
  "threshold": 0.85, "sources": ["ofac_sdn","un"], "limit": 10 }   // opcionales
// response
{ "query_normalized": "JUAN CARLOS PEREZ DE LA CRUZ",
  "matches": [ {
     "source": "ofac_sdn", "category": "sanction", "entry_id": "12345",
     "name": "PEREZ DE LA CRUZ, Juan", "matched_name": "PEREZ DE LA CRUZ, Juan",
     "score": 0.93, "kind": "individual", "programs": ["SDNTK"],
     "birth_dates": ["1970"], "nationalities": ["PE"],
     "reasons": ["tokens: 4/4", "jaro_winkler: 0.96", "fecha de nacimiento coincide"]
  } ] }
```
Coincidencia pensada para nombres peruanos: mayúsculas, sin tildes, partículas
(`DE`, `DEL`, `DE LA`, `DE LOS`, `LA`, `LOS`, `Y`, `VDA DE`) tratadas aparte, dos
apellidos, orden libre, errores de tipeo (Jaro‑Winkler por token) y una clave fonética
española para el bloqueo. Una fecha de nacimiento distinta resta puntaje; una igual suma.

### `POST /v1/screen/batch`
`{ "subjects": [ { "ref": "cli-1", "name": "…", "kind": "individual", "birth_date": "…" } ], "threshold": 0.85 }`
→ `{ "results": [ { "ref": "cli-1", "matches": [ … ] } ] }`
