//! Análisis estructural de PDF sobre los bytes (sin renderizar): metadatos,
//! actualizaciones incrementales, cifrado, JavaScript, fuentes y capa de texto.
//! Los flujos FlateDecode se descomprimen (con tope) para ver objetos dentro de
//! flujos de objetos (PDF ≥ 1.5).

pub mod crypt;
pub mod syntax;

use std::collections::BTreeSet;
use std::io::Read;
use std::sync::LazyLock;

use chrono::{DateTime, FixedOffset, NaiveDate, TimeZone};
use regex::bytes::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ukuk_core::{DocumentType, Finding, Layer, Severity};

use self::crypt::Encryption;
use self::syntax::{decode_text, find_all_keys, find_key, int_after, string_value_after};

const MAX_STREAM_INFLATE: u64 = 16 << 20;
const MAX_TOTAL_INFLATE: usize = 96 << 20;
/// Más familias tipográficas que esto en un comprobante es inusual.
pub const MAX_FONT_FAMILIES: usize = 6;
/// Diferencia mínima (s) entre creación y modificación para considerarla edición.
const MOD_TOLERANCE_SECS: i64 = 120;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PdfReport {
    pub version: Option<String>,
    pub pages: u32,
    pub producer: Option<String>,
    pub creator: Option<String>,
    pub creation_date: Option<String>,
    pub mod_date: Option<String>,
    pub incremental_updates: u32,
    pub encrypted: bool,
    pub has_javascript: bool,
    pub has_text_layer: bool,
    pub fonts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PdfAnalysis {
    pub report: PdfReport,
    pub findings: Vec<Finding>,
}

static STREAM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"stream\r?\n").unwrap());
static BASEFONT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/BaseFont\s*/([^\s/\[\]<>()%{}]+)").unwrap());
static PAGES_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/Type\s*/Pages\b").unwrap());
static PAGE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/Type\s*/Page[^s\w]").unwrap());
static TEXT_OP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[)>\]]\s*T[jJ]\b|'\s*\n").unwrap());
static XMP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)<(pdf:Producer|xmp:CreatorTool|xmp:CreateDate|xmp:ModifyDate)>([^<]*)</")
        .unwrap()
});

const EDITORS: &[&str] = &[
    "ilovepdf",
    "smallpdf",
    "sejda",
    "pdfescape",
    "phantompdf",
    "foxit pdf editor",
    "foxit editor",
    "pdf-xchange editor",
    "pdfelement",
    "wondershare",
    "nitro pro",
    "nitro pdf",
    "pdf candy",
    "pdffiller",
    "dochub",
    "soda pdf",
    "sodapdf",
    "pdf24",
    "canva",
    "photoshop",
    "acrobat pro",
    "adobe acrobat",
    "pdf editor",
    "master pdf",
    "inkscape",
    "libreoffice draw",
];
const WORD_PROCESSORS: &[&str] = &[
    "microsoft® word",
    "microsoft word",
    "microsoft® excel",
    "microsoft excel",
    "libreoffice writer",
    "openoffice",
    "writer",
    "wps office",
    "wps writer",
    "pages",
];

/// Texto descomprimido de los flujos FlateDecode.
fn inflate_streams(raw: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut total = 0usize;
    for m in STREAM_RE.find_iter(raw) {
        // "endstream" también coincide; se descarta.
        if m.start() >= 3 && &raw[m.start() - 3..m.start()] == b"end" {
            continue;
        }
        let dict_start = raw[m.start().saturating_sub(2048)..m.start()]
            .windows(3)
            .rposition(|w| w == b"obj")
            .map_or(m.start().saturating_sub(2048), |p| {
                m.start().saturating_sub(2048) + p
            });
        let dict = &raw[dict_start..m.start()];
        if memchr::memmem::find(dict, b"FlateDecode").is_none() {
            continue;
        }
        let body_start = m.end();
        let Some(rel_end) = memchr::memmem::find(&raw[body_start..], b"endstream") else {
            continue;
        };
        let body = &raw[body_start..body_start + rel_end];
        let mut buf = Vec::new();
        let decoder = flate2::read::ZlibDecoder::new(body);
        // Un flujo truncado igual aporta lo que se alcanzó a descomprimir.
        let _ = decoder.take(MAX_STREAM_INFLATE).read_to_end(&mut buf);
        if buf.is_empty() {
            continue;
        }
        total += buf.len();
        out.push(buf);
        if total > MAX_TOTAL_INFLATE {
            break;
        }
    }
    out
}

/// Último valor de cadena de `/Key` (las actualizaciones incrementales van al final).
fn last_string(raw: &[u8], inflated: &[Vec<u8>], key: &[u8]) -> Option<String> {
    let from = |data: &[u8]| {
        find_all_keys(data, key)
            .into_iter()
            .rev()
            .find_map(|p| string_value_after(data, p, key.len()))
    };
    from(raw)
        .or_else(|| inflated.iter().rev().find_map(|d| from(d)))
        .map(|b| decode_text(&b).trim().to_string())
        .filter(|s| !s.is_empty())
}

fn xmp_values(raw: &[u8], inflated: &[Vec<u8>]) -> Vec<(String, String)> {
    std::iter::once(raw)
        .chain(inflated.iter().map(Vec::as_slice))
        .flat_map(|d| {
            XMP_RE.captures_iter(d).map(|c| {
                (
                    String::from_utf8_lossy(&c[1]).into_owned(),
                    String::from_utf8_lossy(&c[2]).trim().to_string(),
                )
            })
        })
        .filter(|(_, v)| !v.is_empty())
        .collect()
}

/// Interpreta fechas PDF `D:YYYYMMDDHHmmSSOHH'mm'` (componentes finales opcionales).
pub fn parse_pdf_date(s: &str) -> Option<DateTime<FixedOffset>> {
    let s = s.trim().trim_start_matches("D:");
    let digits: String = s.chars().take_while(char::is_ascii_digit).collect();
    if digits.len() < 4 {
        return None;
    }
    let num = |a: usize, b: usize, default: u32| {
        digits
            .get(a..b)
            .and_then(|x| x.parse().ok())
            .unwrap_or(default)
    };
    let year: i32 = digits[0..4].parse().ok()?;
    let date = NaiveDate::from_ymd_opt(year, num(4, 6, 1), num(6, 8, 1))?;
    let time = date.and_hms_opt(num(8, 10, 0), num(10, 12, 0), num(12, 14, 0))?;
    let rest = &s[digits.len()..];
    let offset = match rest.chars().next() {
        Some(sign @ ('+' | '-')) => {
            let tz: String = rest[1..].chars().filter(char::is_ascii_digit).collect();
            let h: i32 = tz.get(0..2).and_then(|x| x.parse().ok()).unwrap_or(0);
            let m: i32 = tz.get(2..4).and_then(|x| x.parse().ok()).unwrap_or(0);
            let secs = h * 3600 + m * 60;
            FixedOffset::east_opt(if sign == '-' { -secs } else { secs })?
        }
        _ => FixedOffset::east_opt(0)?,
    };
    offset.from_local_datetime(&time).single()
}

/// Fecha ISO 8601 de XMP → mismo formato que `parse_pdf_date`.
fn parse_xmp_date(s: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(s.trim()).ok().or_else(|| {
        let digits: String = s.chars().filter(char::is_ascii_digit).take(14).collect();
        parse_pdf_date(&digits)
    })
}

fn font_family(font: &str) -> String {
    let base = font.split([',', '-']).next().unwrap_or(font);
    let base = base.strip_suffix("MT").unwrap_or(base);
    let base = base.strip_suffix("PS").unwrap_or(base);
    base.to_ascii_lowercase()
}

fn decode_name(name: &[u8]) -> String {
    let mut out = Vec::with_capacity(name.len());
    let mut i = 0;
    while i < name.len() {
        if name[i] == b'#'
            && i + 2 < name.len()
            && let Ok(v) = u8::from_str_radix(&String::from_utf8_lossy(&name[i + 1..i + 3]), 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(name[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn strip_subset(font: &str) -> &str {
    match font.split_once('+') {
        Some((prefix, rest))
            if prefix.len() == 6 && prefix.bytes().all(|b| b.is_ascii_uppercase()) =>
        {
            rest
        }
        _ => font,
    }
}

fn page_count(raw: &[u8], inflated: &[Vec<u8>]) -> u32 {
    let sources = || std::iter::once(raw).chain(inflated.iter().map(Vec::as_slice));
    let mut max_count = 0i64;
    for data in sources() {
        for m in PAGES_RE.find_iter(data) {
            // /Count dentro de la ventana del diccionario /Pages.
            let start = m.start().saturating_sub(512);
            let end = (m.end() + 512).min(data.len());
            let window = &data[start..end];
            if let Some(k) = find_key(window, b"/Count", 0)
                && let Some(c) = int_after(window, k, 6)
            {
                max_count = max_count.max(c);
            }
        }
    }
    if max_count > 0 {
        return max_count.min(100_000) as u32;
    }
    sources().map(|d| PAGE_RE.find_iter(d).count() as u32).sum()
}

fn has_key(raw: &[u8], inflated: &[Vec<u8>], key: &[u8]) -> bool {
    find_key(raw, key, 0).is_some() || inflated.iter().any(|d| find_key(d, key, 0).is_some())
}

fn matches_any<'a>(value: &str, list: &[&'a str]) -> Option<&'a str> {
    let lower = value.to_lowercase();
    list.iter().find(|e| lower.contains(*e)).copied()
}

pub fn is_pdf(raw: &[u8]) -> bool {
    memchr::memmem::find(&raw[..raw.len().min(1024)], b"%PDF-").is_some()
}

pub fn analyze_pdf(raw: &[u8], document_type: Option<DocumentType>) -> Result<PdfAnalysis, String> {
    let header = memchr::memmem::find(&raw[..raw.len().min(1024)], b"%PDF-")
        .ok_or_else(|| "el archivo no tiene cabecera %PDF".to_string())?;
    let version = raw[header + 5..]
        .iter()
        .take(4)
        .take_while(|b| b.is_ascii_digit() || **b == b'.')
        .map(|b| char::from(*b))
        .collect::<String>();
    let mut findings = Vec::new();
    let mut report = PdfReport {
        version: (!version.is_empty()).then_some(version),
        ..Default::default()
    };

    let encryption = crypt::check(raw);
    report.encrypted = encryption != Encryption::None;
    match &encryption {
        Encryption::None => {}
        Encryption::OpensWithoutPassword { revision } => findings.push(
            Finding::new(
                "pdf.encrypted",
                Layer::Forensics,
                Severity::Low,
                0.9,
                "El PDF está cifrado con restricciones de propietario (se abre sin contraseña); el contenido interno no se pudo inspeccionar por completo.",
            )
            .with_evidence(json!({ "revision": revision })),
        ),
        Encryption::PasswordRequired { revision } => findings.push(
            Finding::new(
                "file.password_protected",
                Layer::Quality,
                Severity::High,
                1.0,
                "El PDF está protegido con contraseña y no se puede abrir: no es posible verificarlo.",
            )
            .with_evidence(json!({ "revision": revision })),
        ),
        Encryption::Unsupported { filter } => findings.push(
            Finding::new(
                "file.password_protected",
                Layer::Quality,
                Severity::High,
                1.0,
                "El PDF usa un cifrado no estándar (certificado u otro) y no se puede abrir: no es posible verificarlo.",
            )
            .with_evidence(json!({ "filter": filter })),
        ),
    }

    // Con cifrado, los flujos están cifrados: solo se usan los bytes crudos.
    let inflated = if report.encrypted {
        Vec::new()
    } else {
        inflate_streams(raw)
    };
    let xmp = if report.encrypted {
        Vec::new()
    } else {
        xmp_values(raw, &inflated)
    };
    let xmp_get = |k: &str| {
        xmp.iter()
            .rev()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.clone())
    };

    if !report.encrypted {
        report.producer =
            last_string(raw, &inflated, b"/Producer").or_else(|| xmp_get("pdf:Producer"));
        report.creator =
            last_string(raw, &inflated, b"/Creator").or_else(|| xmp_get("xmp:CreatorTool"));
        report.creation_date = last_string(raw, &inflated, b"/CreationDate");
        report.mod_date = last_string(raw, &inflated, b"/ModDate");
    }
    report.pages = page_count(raw, &inflated);

    let eof_count = memchr::memmem::find_iter(raw, b"%%EOF").count() as u32;
    let linearized = memchr::memmem::find(&raw[..raw.len().min(4096)], b"/Linearized").is_some();
    report.incremental_updates =
        eof_count.saturating_sub(1 + u32::from(linearized && eof_count > 1));

    report.has_javascript =
        has_key(raw, &inflated, b"/JavaScript") || has_key(raw, &inflated, b"/JS");

    let mut fonts = BTreeSet::new();
    for data in std::iter::once(raw).chain(inflated.iter().map(Vec::as_slice)) {
        for c in BASEFONT_RE.captures_iter(data) {
            let name = decode_name(&c[1]);
            fonts.insert(strip_subset(&name).to_string());
        }
    }
    report.fonts = fonts.into_iter().collect();
    let text_ops = inflated.iter().any(|d| TEXT_OP_RE.is_match(d)) || TEXT_OP_RE.is_match(raw);
    report.has_text_layer = !report.fonts.is_empty() && (text_ops || report.encrypted);

    let signatures = memchr::memmem::find_iter(raw, b"/ByteRange").count();

    // Herramientas de edición.
    let tools: Vec<(&str, String)> = [("producer", &report.producer), ("creator", &report.creator)]
        .into_iter()
        .filter_map(|(k, v)| v.as_ref().map(|v| (k, v.clone())))
        .chain(xmp_get("pdf:Producer").map(|v| ("xmp_producer", v)))
        .chain(xmp_get("xmp:CreatorTool").map(|v| ("xmp_creator_tool", v)))
        .collect();
    let is_generator = |v: &str| {
        let l = v.to_lowercase();
        l.contains("distiller")
            || l.contains("pdfmaker")
            || (l.contains("adobe pdf library") && !l.contains("acrobat"))
    };
    if let Some((field, tool, editor)) = tools
        .iter()
        .filter(|(_, v)| !is_generator(v))
        .find_map(|(k, v)| matches_any(v, EDITORS).map(|e| (*k, v.clone(), e)))
    {
        findings.push(
            Finding::new(
                "pdf.editing_software",
                Layer::Forensics,
                Severity::Medium,
                0.65,
                format!("El PDF fue procesado con un editor de PDF ({tool}); pudo haberse modificado después de emitido."),
            )
            .with_evidence(json!({ "field": field, "tool": tool, "editor": editor })),
        );
    }
    if document_type.is_some_and(DocumentType::is_system_generated)
        && let Some((field, tool, wp)) = tools
            .iter()
            .find_map(|(k, v)| matches_any(v, WORD_PROCESSORS).map(|e| (*k, v.clone(), e)))
    {
        findings.push(
            Finding::new(
                "pdf.word_processor_origin",
                Layer::Forensics,
                Severity::High,
                0.7,
                format!("El comprobante debería salir de un sistema de facturación o planillas, pero el PDF fue generado con un procesador de texto u hoja de cálculo ({tool})."),
            )
            .with_evidence(json!({ "field": field, "tool": tool, "matched": wp, "document_type": document_type })),
        );
    }

    // Fechas de creación y modificación.
    let created = report
        .creation_date
        .as_deref()
        .and_then(parse_pdf_date)
        .or_else(|| {
            xmp_get("xmp:CreateDate")
                .as_deref()
                .and_then(parse_xmp_date)
        });
    let modified = report
        .mod_date
        .as_deref()
        .and_then(parse_pdf_date)
        .or_else(|| {
            xmp_get("xmp:ModifyDate")
                .as_deref()
                .and_then(parse_xmp_date)
        });
    if let (Some(c), Some(m)) = (created, modified) {
        let diff = (m - c).num_seconds();
        if diff > MOD_TOLERANCE_SECS {
            let severity = if document_type.is_some_and(DocumentType::is_system_generated) {
                Severity::Medium
            } else {
                Severity::Low
            };
            findings.push(
                Finding::new(
                    "pdf.modified_after_creation",
                    Layer::Forensics,
                    severity,
                    0.6,
                    format!(
                        "El PDF fue modificado después de su creación ({} → {}).",
                        c.to_rfc3339(),
                        m.to_rfc3339()
                    ),
                )
                .with_evidence(json!({
                    "creation_date": report.creation_date,
                    "mod_date": report.mod_date,
                    "seconds": diff,
                })),
            );
        }
    }

    if report.incremental_updates > 0 {
        let signed_only = signatures > 0 && signatures as u32 >= report.incremental_updates;
        let (severity, confidence, message) = if signed_only {
            (
                Severity::Info,
                0.5,
                "El PDF tiene actualizaciones incrementales que coinciden con firmas digitales (normal al firmar).".to_string(),
            )
        } else {
            (
                Severity::Medium,
                0.75,
                format!(
                    "El PDF tiene {} actualización(es) incremental(es): se le agregó o cambió contenido después de guardarlo.",
                    report.incremental_updates
                ),
            )
        };
        findings.push(
            Finding::new(
                "pdf.incremental_update",
                Layer::Forensics,
                severity,
                confidence,
                message,
            )
            .with_evidence(json!({
                "incremental_updates": report.incremental_updates,
                "eof_markers": eof_count,
                "linearized": linearized,
                "signatures": signatures,
            })),
        );
    }

    if report.has_javascript {
        findings.push(Finding::new(
            "pdf.javascript",
            Layer::Forensics,
            Severity::High,
            0.9,
            "El PDF contiene JavaScript, inusual en comprobantes y documentos legítimos.",
        ));
    }

    let families: BTreeSet<String> = report.fonts.iter().map(|f| font_family(f)).collect();
    if families.len() > MAX_FONT_FAMILIES {
        findings.push(
            Finding::new(
                "pdf.mixed_fonts",
                Layer::Forensics,
                Severity::Medium,
                0.5,
                format!("El PDF usa {} familias tipográficas distintas; puede indicar texto agregado o reemplazado.", families.len()),
            )
            .with_evidence(json!({ "families": families, "fonts": report.fonts })),
        );
    }

    if !report.has_text_layer
        && !report.encrypted
        && report.pages > 0
        && document_type.is_some_and(DocumentType::is_system_generated)
    {
        findings.push(Finding::new(
            "pdf.no_text_layer",
            Layer::Forensics,
            Severity::Low,
            0.5,
            "El PDF no tiene capa de texto (es una imagen escaneada o rasterizada) aunque el documento suele emitirse digitalmente.",
        ));
    }

    Ok(PdfAnalysis { report, findings })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::ZlibEncoder;
    use std::io::Write;

    /// PDF mínimo pero bien formado (xref aproximado: el analizador no lo usa).
    pub(crate) fn simple_pdf(
        producer: &str,
        creation: &str,
        modified: &str,
        fonts: &[&str],
    ) -> Vec<u8> {
        let content = b"BT /F1 12 Tf 72 712 Td (Total S/ 118.00) Tj ET";
        let mut z = ZlibEncoder::new(Vec::new(), Compression::default());
        z.write_all(content).unwrap();
        let compressed = z.finish().unwrap();
        let mut font_objs = String::new();
        for (i, f) in fonts.iter().enumerate() {
            font_objs.push_str(&format!(
                "{} 0 obj << /Type /Font /Subtype /TrueType /BaseFont /{f} >> endobj\n",
                10 + i
            ));
        }
        let mut pdf = format!(
            "%PDF-1.7\n%\u{e2}\u{e3}\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /Contents 5 0 R >> endobj\n4 0 obj << /Type /Page /Parent 2 0 R /Contents 5 0 R >> endobj\n{font_objs}6 0 obj << /Producer ({producer}) /Creator (Sistema Facturador) /CreationDate ({creation}) /ModDate ({modified}) >> endobj\n5 0 obj << /Length {} /Filter /FlateDecode >>\nstream\n",
            compressed.len()
        )
        .into_bytes();
        pdf.extend_from_slice(&compressed);
        pdf.extend_from_slice(
            b"\nendstream\nendobj\ntrailer << /Root 1 0 R /Info 6 0 R >>\nstartxref\n0\n%%EOF\n",
        );
        pdf
    }

    fn codes(a: &PdfAnalysis) -> Vec<&str> {
        a.findings.iter().map(|f| f.code.as_str()).collect()
    }

    #[test]
    fn clean_pdf() {
        let pdf = simple_pdf(
            "Facturador SUNAT",
            "D:20260315101500-05'00'",
            "D:20260315101500-05'00'",
            &["ABCDEF+Arial-BoldMT", "Helvetica"],
        );
        let a = analyze_pdf(&pdf, Some(DocumentType::Factura)).unwrap();
        assert!(a.findings.is_empty(), "{:?}", a.findings);
        let r = &a.report;
        assert_eq!(r.version.as_deref(), Some("1.7"));
        assert_eq!(r.pages, 2);
        assert_eq!(r.producer.as_deref(), Some("Facturador SUNAT"));
        assert_eq!(r.creator.as_deref(), Some("Sistema Facturador"));
        assert_eq!(r.incremental_updates, 0);
        assert!(!r.encrypted && !r.has_javascript);
        assert!(r.has_text_layer);
        assert_eq!(r.fonts, vec!["Arial-BoldMT", "Helvetica"]);
    }

    #[test]
    fn edited_pdf_with_incremental_update() {
        let mut pdf = simple_pdf(
            "iLovePDF",
            "D:20260315101500-05'00'",
            "D:20260320120000-05'00'",
            &["Arial"],
        );
        pdf.extend_from_slice(b"7 0 obj << /Producer (Smallpdf) >> endobj\ntrailer << /Prev 0 /Info 7 0 R >>\nstartxref\n0\n%%EOF\n");
        let a = analyze_pdf(&pdf, Some(DocumentType::Factura)).unwrap();
        let c = codes(&a);
        assert!(c.contains(&"pdf.editing_software"), "{c:?}");
        assert!(c.contains(&"pdf.modified_after_creation"));
        assert!(c.contains(&"pdf.incremental_update"));
        assert_eq!(a.report.incremental_updates, 1);
        assert_eq!(a.report.producer.as_deref(), Some("Smallpdf"));
    }

    #[test]
    fn word_processor_only_flagged_for_system_documents() {
        let pdf = simple_pdf(
            "Microsoft\\256 Word para Microsoft 365",
            "D:2026",
            "D:2026",
            &["Calibri"],
        );
        let a = analyze_pdf(&pdf, Some(DocumentType::BoletaPago)).unwrap();
        assert!(codes(&a).contains(&"pdf.word_processor_origin"));
        let a = analyze_pdf(&pdf, Some(DocumentType::InformeMedico)).unwrap();
        assert!(!codes(&a).contains(&"pdf.word_processor_origin"));
    }

    #[test]
    fn javascript_and_mixed_fonts() {
        let mut pdf = simple_pdf(
            "X",
            "D:2026",
            "D:2026",
            &[
                "Arial",
                "Times-Roman",
                "Courier",
                "Verdana",
                "Georgia",
                "Tahoma",
                "Calibri",
                "ComicSansMS",
            ],
        );
        pdf.extend_from_slice(b"9 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj\n");
        let a = analyze_pdf(&pdf, None).unwrap();
        assert!(codes(&a).contains(&"pdf.javascript"));
        assert!(codes(&a).contains(&"pdf.mixed_fonts"));
    }

    #[test]
    fn signed_incremental_update_is_info() {
        let mut pdf = simple_pdf("X", "D:2026", "D:2026", &["Arial"]);
        pdf.extend_from_slice(
            b"8 0 obj << /Type /Sig /ByteRange [0 1 2 3] >> endobj\nstartxref\n0\n%%EOF\n",
        );
        let a = analyze_pdf(&pdf, None).unwrap();
        let f = a
            .findings
            .iter()
            .find(|f| f.code == "pdf.incremental_update")
            .unwrap();
        assert_eq!(f.severity, Severity::Info);
    }

    #[test]
    fn linearized_pdf_is_not_incremental() {
        let mut pdf =
            b"%PDF-1.5\n1 0 obj << /Linearized 1 /L 100 >> endobj\nstartxref\n0\n%%EOF\n".to_vec();
        pdf.extend_from_slice(&simple_pdf("X", "D:2026", "D:2026", &["Arial"])[9..]);
        let a = analyze_pdf(&pdf, None).unwrap();
        assert_eq!(a.report.incremental_updates, 0);
    }

    #[test]
    fn encrypted_pdfs() {
        let a = analyze_pdf(&super::crypt::tests::encrypted_pdf(false), None).unwrap();
        assert!(a.report.encrypted);
        assert_eq!(codes(&a), vec!["file.password_protected"]);
        let a = analyze_pdf(&super::crypt::tests::encrypted_pdf(true), None).unwrap();
        assert_eq!(codes(&a), vec!["pdf.encrypted"]);
        assert_eq!(a.report.pages, 1);
    }

    #[test]
    fn xmp_and_hex_metadata() {
        let pdf = b"%PDF-1.4\n1 0 obj << /Producer <FEFF00530065006A00640061> >> endobj\n2 0 obj << /Type /Metadata >> stream\n<x:xmpmeta><xmp:CreatorTool>PDFescape Online</xmp:CreatorTool></x:xmpmeta>\nendstream\n%%EOF";
        let a = analyze_pdf(pdf, None).unwrap();
        assert_eq!(a.report.producer.as_deref(), Some("Sejda"));
        assert_eq!(a.report.creator.as_deref(), Some("PDFescape Online"));
        assert!(codes(&a).contains(&"pdf.editing_software"));
    }

    #[test]
    fn not_a_pdf() {
        assert!(analyze_pdf(b"hello", None).is_err());
        assert!(!is_pdf(b"hello"));
    }

    #[test]
    fn pdf_dates() {
        let d = parse_pdf_date("D:20260315101500-05'00'").unwrap();
        assert_eq!(d.to_rfc3339(), "2026-03-15T10:15:00-05:00");
        let d = parse_pdf_date("D:2026").unwrap();
        assert_eq!(d.to_rfc3339(), "2026-01-01T00:00:00+00:00");
        assert!(parse_pdf_date("garbage").is_none());
        assert!(parse_xmp_date("2026-03-15T10:15:00-05:00").is_some());
    }

    #[test]
    fn font_helpers() {
        assert_eq!(strip_subset("ABCDEF+Arial"), "Arial");
        assert_eq!(strip_subset("Abcdef+Arial"), "Abcdef+Arial");
        assert_eq!(decode_name(b"Arial#20Bold"), "Arial Bold");
        assert_eq!(font_family("Arial-BoldMT"), "arial");
        assert_eq!(font_family("ArialMT"), "arial");
    }
}
