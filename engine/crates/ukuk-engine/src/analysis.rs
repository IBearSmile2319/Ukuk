//! Orquestación de `/v1/analyze`: decodifica, detecta el tipo real, ejecuta los
//! analizadores que correspondan y combina los hallazgos.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use chrono::{FixedOffset, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use ukuk_core::{DocumentFields, DocumentType, ENGINE_VERSION, Finding, Layer, OcrWord, Severity};
use ukuk_forensics::{ImageReport, PdfReport, Template, XmlReport};
use ukuk_peru::MrzData;

use crate::ApiError;

#[derive(Debug, Clone, Deserialize)]
pub struct AnalyzeRequest {
    pub file_base64: String,
    pub mime_type: String,
    #[serde(default)]
    pub document_type: Option<DocumentType>,
    #[serde(default)]
    pub ocr_words: Option<Vec<OcrWord>>,
    #[serde(default)]
    pub fields: Option<DocumentFields>,
    #[serde(default)]
    pub template: Option<Template>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyzeResponse {
    pub engine_version: &'static str,
    pub sha256: String,
    pub mime_type: String,
    pub image: Option<ImageReport>,
    pub pdf: Option<PdfReport>,
    pub xml: Option<XmlReport>,
    pub mrz: Option<MrzData>,
    pub findings: Vec<Finding>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Image,
    Pdf,
    Xml,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Self::Image => "imagen",
            Self::Pdf => "PDF",
            Self::Xml => "XML",
        }
    }
}

/// Fecha actual en Lima (UTC−5, sin horario de verano).
pub fn today_lima() -> NaiveDate {
    let lima = FixedOffset::west_opt(5 * 3600).expect("offset válido");
    Utc::now().with_timezone(&lima).date_naive()
}

/// Normaliza el MIME declarado y devuelve (mime canónico, tipo).
pub fn declared_kind(mime: &str) -> Option<(String, Kind)> {
    let m = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let canonical = match m.as_str() {
        "image/jpeg" | "image/jpg" | "image/pjpeg" => "image/jpeg",
        "image/png" => "image/png",
        "image/webp" => "image/webp",
        "image/tiff" | "image/tif" => "image/tiff",
        "application/pdf" => "application/pdf",
        "application/xml" => "application/xml",
        "text/xml" => "text/xml",
        _ => return None,
    };
    let kind = match canonical {
        "application/pdf" => Kind::Pdf,
        "application/xml" | "text/xml" => Kind::Xml,
        _ => Kind::Image,
    };
    Some((canonical.to_string(), kind))
}

/// Tipo real según los bytes mágicos.
pub fn sniff(bytes: &[u8]) -> Option<(&'static str, Kind)> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(("image/jpeg", Kind::Image));
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(("image/png", Kind::Image));
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(("image/webp", Kind::Image));
    }
    if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        return Some(("image/tiff", Kind::Image));
    }
    if ukuk_forensics::pdf::is_pdf(bytes) {
        return Some(("application/pdf", Kind::Pdf));
    }
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let first = text.iter().find(|b| !b.is_ascii_whitespace());
    if first == Some(&b'<') {
        return Some(("application/xml", Kind::Xml));
    }
    None
}

pub fn decode_base64(input: &str) -> Result<Vec<u8>, ApiError> {
    let data = match input.split_once("base64,") {
        Some((prefix, rest)) if prefix.starts_with("data:") => rest,
        _ => input,
    };
    let cleaned: String = data.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let bytes = [STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD]
        .iter()
        .find_map(|e| e.decode(&cleaned).ok())
        .ok_or_else(|| {
            ApiError::bad_request("invalid_base64", "file_base64 no es base64 válido.")
        })?;
    if bytes.is_empty() {
        return Err(ApiError::bad_request(
            "empty_file",
            "El archivo está vacío.",
        ));
    }
    Ok(bytes)
}

fn unreadable(kind: Kind, error: &str) -> Finding {
    Finding::new(
        "file.unreadable",
        Layer::Quality,
        Severity::High,
        0.95,
        format!(
            "No se pudo leer el archivo como {}: puede estar dañado o no ser lo que declara.",
            kind.label()
        ),
    )
    .with_evidence(json!({ "error": error }))
}

/// Ejecuta el análisis completo (síncrono: llamar desde `spawn_blocking`).
pub fn run(req: AnalyzeRequest, today: NaiveDate) -> Result<AnalyzeResponse, ApiError> {
    let (declared_mime, declared) = declared_kind(&req.mime_type).ok_or_else(|| {
        ApiError::bad_request(
            "unsupported_mime_type",
            format!("Tipo de archivo no soportado: {}.", req.mime_type),
        )
    })?;
    let bytes = decode_base64(&req.file_base64)?;
    let sha256 = hex::encode(Sha256::digest(&bytes));
    let mut findings = Vec::new();

    let (mime_type, kind) = match sniff(&bytes) {
        Some((real_mime, real))
            if real != declared || (real == Kind::Image && real_mime != declared_mime) =>
        {
            findings.push(
                Finding::new(
                    "file.mime_mismatch",
                    Layer::Classification,
                    Severity::Medium,
                    0.9,
                    format!("El archivo se declaró como {declared_mime} pero su contenido es {real_mime}."),
                )
                .with_evidence(json!({ "declared": declared_mime, "detected": real_mime })),
            );
            (real_mime.to_string(), real)
        }
        _ => (declared_mime, declared),
    };

    let fields = req.fields.as_ref();
    let mut image = None;
    let mut pdf = None;
    let mut xml = None;
    match kind {
        Kind::Image => match ukuk_forensics::analyze_image(&bytes, req.document_type.is_some()) {
            Ok(a) => {
                findings.extend(a.findings);
                image = Some(a.report);
            }
            Err(e) => findings.push(unreadable(kind, &e.to_string())),
        },
        Kind::Pdf => match ukuk_forensics::analyze_pdf(&bytes, req.document_type) {
            Ok(a) => {
                findings.extend(a.findings);
                pdf = Some(a.report);
            }
            Err(e) => findings.push(unreadable(kind, &e)),
        },
        Kind::Xml => match ukuk_forensics::analyze_xml(&bytes, fields) {
            Ok(a) => {
                findings.extend(a.findings);
                xml = Some(a.report);
            }
            Err(e) => findings.push(unreadable(kind, &e)),
        },
    }

    let mut mrz = None;
    if let Some(f) = fields {
        findings.extend(ukuk_peru::check_fields(f, req.document_type, today));
        if let Some(raw) = f.mrz.as_deref().filter(|m| !m.trim().is_empty()) {
            let parsed = ukuk_peru::mrz::parse_td1(raw, today);
            findings.extend(parsed.findings);
            findings.extend(ukuk_peru::mrz::cross_check(&parsed.mrz, f, Some(raw)));
            mrz = Some(parsed.mrz);
        }
    }
    // El vencimiento ya reportado por la MRZ no se duplica.
    if findings.iter().any(|f| f.code == "mrz.expired") {
        findings.retain(|f| f.code != "dates.document_expired");
    }

    let words = req.ocr_words.as_deref().unwrap_or_default();
    // La revisión de diseño genérica solo vale en comprobantes, donde el texto va en una
    // misma letra. Un carnet o un acta mezclan tamaños a propósito (etiqueta pequeña, dato
    // grande): ahí solo vale la comparación con la plantilla de su formato.
    let receipt = matches!(
        req.document_type,
        Some(
            DocumentType::BoletaVenta
                | DocumentType::Factura
                | DocumentType::BoletaPago
                | DocumentType::ReciboServicio
        )
    );
    if !words.is_empty() && receipt {
        findings.extend(ukuk_forensics::analyze_layout(words));
    }
    drop_mrz_clones(&mut findings, words);
    // Experimental: medido con actas reales, todavía no separa adulteradas de legítimas
    // (docs/roadmap.md). Solo corre al calibrar, con UKUK_TEXT_OUTLIER o UKUK_PATCH_RATIO.
    let calibrating = std::env::var_os("UKUK_TEXT_OUTLIER").is_some()
        || std::env::var_os("UKUK_PATCH_RATIO").is_some();
    if calibrating && kind == Kind::Image && req.document_type.is_some() && !words.is_empty() {
        findings.extend(text_marks(&bytes, words));
    }
    findings.extend(ukuk_forensics::compare_template(
        req.template.as_ref(),
        words,
    ));

    findings.sort_by_key(|f| std::cmp::Reverse(f.severity));
    Ok(AnalyzeResponse {
        engine_version: ENGINE_VERSION,
        sha256,
        mime_type,
        image,
        pdf,
        xml,
        mrz,
        findings,
        duration_ms: 0,
    })
}

/// Palabras que no se parecen a ninguna otra del documento (texto reescrito o pegado).
/// `UKUK_TEXT_OUTLIER` y `UKUK_PATCH_RATIO` ajustan los umbrales para calibrar con documentos reales.
fn text_marks(bytes: &[u8], words: &[OcrWord]) -> Vec<Finding> {
    let env = |k: &str, d: f64| {
        std::env::var(k)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(d)
    };
    let threshold = env(
        "UKUK_TEXT_OUTLIER",
        ukuk_forensics::image::text_marks::DEFAULT_OUTLIER,
    );
    let patch = env(
        "UKUK_PATCH_RATIO",
        ukuk_forensics::image::text_marks::DEFAULT_PATCH,
    );
    match ukuk_forensics::decode(bytes) {
        // Sin aplicar la orientación EXIF: el OCR leyó los píxeles tal como vienen.
        Ok((img, _, _)) => {
            ukuk_forensics::analyze_text_marks(&img.to_luma8(), words, threshold, patch)
        }
        Err(_) => Vec::new(),
    }
}

/// Los rellenos «<<<<» de una MRZ se repiten entre sus líneas: un «clonado» con
/// origen y destino dentro de la franja que ubicó el OCR no dice nada.
fn drop_mrz_clones(findings: &mut Vec<Finding>, words: &[OcrWord]) {
    let lines: Vec<_> = words
        .iter()
        .filter(|w| w.text.contains("<<"))
        .map(|w| w.bbox)
        .collect();
    if lines.is_empty() {
        return;
    }
    const MARGIN: f64 = 0.02;
    let x0 = lines.iter().map(|b| b.x).fold(f64::MAX, f64::min) - MARGIN;
    let y0 = lines.iter().map(|b| b.y).fold(f64::MAX, f64::min) - MARGIN;
    let x1 = lines.iter().map(|b| b.x + b.w).fold(f64::MIN, f64::max) + MARGIN;
    let y1 = lines.iter().map(|b| b.y + b.h).fold(f64::MIN, f64::max) + MARGIN;
    let inside = |x: f64, y: f64, w: f64, h: f64| x >= x0 && y >= y0 && x + w <= x1 && y + h <= y1;
    let source = |f: &Finding| -> Option<(f64, f64, f64, f64)> {
        let r = f.evidence.as_ref()?.get("source_region")?;
        Some((
            r["x"].as_f64()?,
            r["y"].as_f64()?,
            r["w"].as_f64()?,
            r["h"].as_f64()?,
        ))
    };
    findings.retain(|f| {
        let (Some(r), Some((sx, sy, sw, sh))) = (f.region.as_ref(), source(f)) else {
            return true;
        };
        !(f.code == "copy_move.duplicated_region"
            && inside(r.x, r.y, r.w, r.h)
            && inside(sx, sy, sw, sh))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use ukuk_core::{BBox, Region};

    #[test]
    fn clones_inside_the_mrz_are_dropped() {
        let line = |y: f64| OcrWord {
            text: "I<PER45678912<4<<<<<<<<<<<<<<<".into(),
            confidence: 0.9,
            page: 1,
            bbox: BBox {
                x: 0.05,
                y,
                w: 0.88,
                h: 0.05,
            },
        };
        let words = [line(0.70), line(0.79), line(0.88)];
        let clone = |y: f64, sy: f64| {
            Finding::new(
                "copy_move.duplicated_region",
                Layer::Forensics,
                Severity::Medium,
                0.5,
                "x",
            )
            .with_region(Region {
                page: 1,
                x: 0.2,
                y,
                w: 0.4,
                h: 0.06,
            })
            .with_evidence(
                json!({ "source_region": { "page": 1, "x": 0.1, "y": sy, "w": 0.4, "h": 0.06 } }),
            )
        };
        let mut f = vec![clone(0.79, 0.70), clone(0.79, 0.30), clone(0.40, 0.30)];
        drop_mrz_clones(&mut f, &words);
        assert_eq!(
            f.len(),
            2,
            "solo se descarta el que está entero dentro de la MRZ"
        );
        let mut untouched = vec![clone(0.79, 0.70)];
        drop_mrz_clones(&mut untouched, &[]);
        assert_eq!(untouched.len(), 1);
    }

    #[test]
    fn mime_normalization() {
        assert_eq!(declared_kind("image/JPG").unwrap().0, "image/jpeg");
        assert_eq!(
            declared_kind("text/xml; charset=utf-8").unwrap().1,
            Kind::Xml
        );
        assert!(declared_kind("application/zip").is_none());
    }

    #[test]
    fn sniffing() {
        assert_eq!(sniff(b"%PDF-1.7").unwrap().1, Kind::Pdf);
        assert_eq!(sniff(b"\xEF\xBB\xBF  <Invoice/>").unwrap().1, Kind::Xml);
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]).unwrap().0, "image/jpeg");
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 ").unwrap().0, "image/webp");
        assert!(sniff(b"hola").is_none());
    }

    #[test]
    fn base64_variants() {
        assert_eq!(decode_base64("aG9sYQ==").unwrap(), b"hola");
        assert_eq!(decode_base64("aG9sYQ").unwrap(), b"hola");
        assert_eq!(
            decode_base64("data:text/plain;base64,aG9s\nYQ==").unwrap(),
            b"hola"
        );
        assert_eq!(decode_base64("!!!").unwrap_err().code, "invalid_base64");
        assert_eq!(decode_base64("").unwrap_err().code, "empty_file");
    }
}
