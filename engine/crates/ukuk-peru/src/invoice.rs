//! Coherencia aritmética de comprobantes (subtotal + IGV = total, tasa de IGV,
//! suma de ítems) y formato de serie-número SUNAT.

use serde_json::json;
use ukuk_core::{DocumentFields, DocumentType, Finding, Layer, Severity};

/// Tolerancia absoluta para redondeos (en soles).
pub const TOLERANCE: f64 = 0.02;
/// Tasa general (16 % IGV + 2 % IPM) y tasa reducida MYPE de restaurantes/hoteles (Ley 31556).
pub const IGV_RATES: [f64; 2] = [0.18, 0.105];

/// Interpreta montos como `1,234.56`, `1.234,56`, `S/ 118.00`, `118`.
pub fn parse_amount(raw: &str) -> Option<f64> {
    let cleaned: String = raw
        .trim()
        .trim_start_matches("PEN")
        .trim_start_matches("USD")
        .trim_start_matches("S/.")
        .trim_start_matches("S/")
        .trim_start_matches("US$")
        .trim_start_matches('$')
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if cleaned.is_empty()
        || !cleaned
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == ',' || c == '-')
    {
        return None;
    }
    let last_dot = cleaned.rfind('.');
    let last_comma = cleaned.rfind(',');
    let normalized = match (last_dot, last_comma) {
        (Some(d), Some(c)) if c > d => cleaned.replace('.', "").replace(',', "."),
        (Some(_), Some(_)) => cleaned.replace(',', ""),
        (None, Some(c)) => {
            let decimals = cleaned.len() - c - 1;
            if cleaned.matches(',').count() == 1 && decimals <= 2 {
                cleaned.replace(',', ".")
            } else {
                cleaned.replace(',', "")
            }
        }
        _ => cleaned,
    };
    normalized.parse::<f64>().ok().filter(|v| v.is_finite())
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn amount(name: &str, raw: Option<&str>, out: &mut Vec<Finding>) -> Option<f64> {
    let raw = raw.map(str::trim).filter(|s| !s.is_empty())?;
    match parse_amount(raw) {
        Some(v) => Some(v),
        None => {
            out.push(
                Finding::new(
                    "invoice.unparseable_amount",
                    Layer::Extraction,
                    Severity::Low,
                    0.6,
                    format!("No se pudo interpretar el monto «{raw}» del campo {name}."),
                )
                .with_evidence(json!({ "field": name, "value": raw })),
            );
            None
        }
    }
}

pub fn check(fields: &DocumentFields, document_type: Option<DocumentType>) -> Vec<Finding> {
    let mut out = Vec::new();
    let subtotal = amount("subtotal", fields.subtotal.as_deref(), &mut out);
    let igv = amount("igv", fields.igv.as_deref(), &mut out);
    let total = amount("total", fields.total.as_deref(), &mut out);
    let items_total = amount("items_total", fields.items_total.as_deref(), &mut out);

    if let (Some(s), Some(i), Some(t)) = (subtotal, igv, total) {
        let diff = round2(s + i - t);
        if diff.abs() > TOLERANCE {
            out.push(
                Finding::new(
                    "invoice.totals_mismatch",
                    Layer::Consistency,
                    Severity::High,
                    0.95,
                    format!("Subtotal ({s:.2}) + IGV ({i:.2}) no coincide con el total ({t:.2}); diferencia {diff:.2}."),
                )
                .with_evidence(json!({ "subtotal": s, "igv": i, "total": t, "difference": diff })),
            );
        }
    }

    if let (Some(s), Some(i)) = (subtotal, igv)
        && s > 0.0
    {
        if i.abs() <= f64::EPSILON {
            out.push(
                Finding::new(
                    "invoice.igv_zero",
                    Layer::Consistency,
                    Severity::Info,
                    0.5,
                    "El IGV es cero: operación exonerada o inafecta; verificar que corresponda.",
                )
                .with_evidence(json!({ "subtotal": s, "igv": i })),
            );
        } else {
            // Tolerancia: 2 céntimos o 0,05 % del subtotal (redondeo por línea).
            let tol = TOLERANCE.max(s * 0.0005);
            let matched = IGV_RATES.iter().copied().find(|r| (s * r - i).abs() <= tol);
            match matched {
                Some(rate) if rate < 0.18 => out.push(
                    Finding::new(
                        "invoice.igv_reduced_rate",
                        Layer::Consistency,
                        Severity::Info,
                        0.7,
                        "El IGV corresponde a la tasa reducida de 10,5 % (MYPE de restaurantes y hoteles).",
                    )
                    .with_evidence(json!({ "subtotal": s, "igv": i, "rate": rate })),
                ),
                Some(_) => {}
                None => out.push(
                    Finding::new(
                        "invoice.igv_rate_mismatch",
                        Layer::Consistency,
                        Severity::High,
                        0.85,
                        format!(
                            "El IGV ({i:.2}) no corresponde al 18 % ni al 10,5 % del subtotal ({s:.2}); tasa efectiva {:.2} %.",
                            i / s * 100.0
                        ),
                    )
                    .with_evidence(json!({
                        "subtotal": s,
                        "igv": i,
                        "effective_rate": (i / s * 10_000.0).round() / 10_000.0,
                        "expected_18": round2(s * 0.18),
                        "expected_10_5": round2(s * 0.105),
                    })),
                ),
            }
        }
    }

    if let (Some(items), Some(s)) = (items_total, subtotal) {
        // Algunos comprobantes listan ítems con IGV incluido: también se acepta el total.
        let matches_total = total.is_some_and(|t| (items - t).abs() <= TOLERANCE);
        if (items - s).abs() > TOLERANCE && !matches_total {
            out.push(
                Finding::new(
                    "invoice.items_mismatch",
                    Layer::Consistency,
                    Severity::High,
                    0.85,
                    format!("La suma de ítems ({items:.2}) no coincide con el subtotal ({s:.2})."),
                )
                .with_evidence(json!({ "items_total": items, "subtotal": s, "total": total })),
            );
        }
    }

    if let Some(sn) = fields
        .serie_numero
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        && let Some(f) = serie_finding(sn, document_type)
    {
        out.push(f);
    }
    out
}

/// Valida `SERIE-NUMERO`: serie de 4 caracteres (F/B/E + 3 alfanuméricos) y
/// correlativo de hasta 8 dígitos.
pub fn serie_format_ok(serie_numero: &str) -> bool {
    let s = serie_numero.trim().to_ascii_uppercase();
    let Some((serie, numero)) = s.split_once('-') else {
        return false;
    };
    serie.len() == 4
        && matches!(serie.as_bytes()[0], b'F' | b'B' | b'E')
        && serie.bytes().skip(1).all(|b| b.is_ascii_alphanumeric())
        && (1..=8).contains(&numero.len())
        && numero.bytes().all(|b| b.is_ascii_digit())
}

fn serie_finding(serie_numero: &str, document_type: Option<DocumentType>) -> Option<Finding> {
    let applies = matches!(
        document_type,
        None | Some(DocumentType::Factura | DocumentType::BoletaVenta | DocumentType::Other)
    );
    if !applies {
        return None;
    }
    let sn = serie_numero.trim().to_ascii_uppercase();
    let mk = |msg: String, reason: &str| {
        Finding::new(
            "invoice.serie_format",
            Layer::Consistency,
            Severity::High,
            0.9,
            msg,
        )
        .with_evidence(
            json!({ "serie_numero": sn, "reason": reason, "document_type": document_type }),
        )
    };
    if !serie_format_ok(&sn) {
        return Some(mk(
            format!("La serie-número «{sn}» no tiene el formato SUNAT (p. ej. F001-00001234)."),
            "format",
        ));
    }
    let first = sn.as_bytes()[0];
    match document_type {
        Some(DocumentType::Factura) if !matches!(first, b'F' | b'E') => Some(mk(
            format!(
                "La serie «{}» no corresponde a una factura (debe iniciar con F o E).",
                &sn[..4]
            ),
            "prefix",
        )),
        Some(DocumentType::BoletaVenta) if !matches!(first, b'B' | b'E') => Some(mk(
            format!(
                "La serie «{}» no corresponde a una boleta de venta (debe iniciar con B o E).",
                &sn[..4]
            ),
            "prefix",
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(sub: &str, igv: &str, total: &str) -> DocumentFields {
        DocumentFields {
            subtotal: Some(sub.into()),
            igv: Some(igv.into()),
            total: Some(total.into()),
            ..Default::default()
        }
    }

    fn codes(f: &[Finding]) -> Vec<&str> {
        f.iter().map(|f| f.code.as_str()).collect()
    }

    #[test]
    fn parses_amounts() {
        assert_eq!(parse_amount("118.00"), Some(118.0));
        assert_eq!(parse_amount("S/ 1,234.56"), Some(1234.56));
        assert_eq!(parse_amount("S/. 1.234,56"), Some(1234.56));
        assert_eq!(parse_amount("1,5"), Some(1.5));
        assert_eq!(parse_amount("1,234,567"), Some(1_234_567.0));
        assert_eq!(parse_amount("PEN 99"), Some(99.0));
        assert_eq!(parse_amount("abc"), None);
        assert_eq!(parse_amount(""), None);
    }

    #[test]
    fn consistent_invoice() {
        assert!(check(&fields("100.00", "18.00", "118.00"), None).is_empty());
        // dentro de la tolerancia
        assert!(check(&fields("84.75", "15.25", "100.01"), None).is_empty());
    }

    #[test]
    fn totals_mismatch() {
        let c = check(&fields("100.00", "18.00", "128.00"), None);
        assert_eq!(codes(&c), vec!["invoice.totals_mismatch"]);
    }

    #[test]
    fn igv_rates() {
        let c = check(&fields("100.00", "10.50", "110.50"), None);
        assert_eq!(codes(&c), vec!["invoice.igv_reduced_rate"]);
        let c = check(&fields("100.00", "15.00", "115.00"), None);
        assert_eq!(codes(&c), vec!["invoice.igv_rate_mismatch"]);
        let c = check(&fields("100.00", "0.00", "100.00"), None);
        assert_eq!(codes(&c), vec!["invoice.igv_zero"]);
    }

    #[test]
    fn items_total() {
        let mut f = fields("100.00", "18.00", "118.00");
        f.items_total = Some("118.00".into());
        assert!(check(&f, None).is_empty());
        f.items_total = Some("90.00".into());
        assert_eq!(codes(&check(&f, None)), vec!["invoice.items_mismatch"]);
    }

    #[test]
    fn unparseable_amount() {
        let c = check(&fields("cien", "18.00", "118.00"), None);
        assert_eq!(codes(&c), vec!["invoice.unparseable_amount"]);
    }

    #[test]
    fn serie_format() {
        assert!(serie_format_ok("F001-00001234"));
        assert!(serie_format_ok("B0A1-1"));
        assert!(serie_format_ok("e001-123"));
        assert!(!serie_format_ok("F01-123"));
        assert!(!serie_format_ok("X001-123"));
        assert!(!serie_format_ok("F001-123456789"));
        assert!(!serie_format_ok("F001123"));
        assert!(!serie_format_ok("F001-12A"));
    }

    #[test]
    fn serie_prefix_by_document_type() {
        let mut f = DocumentFields {
            serie_numero: Some("B001-123".into()),
            ..Default::default()
        };
        assert_eq!(
            codes(&check(&f, Some(DocumentType::Factura))),
            vec!["invoice.serie_format"]
        );
        assert!(check(&f, Some(DocumentType::BoletaVenta)).is_empty());
        f.serie_numero = Some("F001-123".into());
        assert_eq!(
            codes(&check(&f, Some(DocumentType::BoletaVenta))),
            vec!["invoice.serie_format"]
        );
        f.serie_numero = Some("E001-55".into());
        assert!(check(&f, Some(DocumentType::Factura)).is_empty());
        assert!(check(&f, Some(DocumentType::BoletaVenta)).is_empty());
        // los recibos de servicios usan otras series (S001…): no se validan
        f.serie_numero = Some("S001-55".into());
        assert!(check(&f, Some(DocumentType::ReciboServicio)).is_empty());
    }
}
