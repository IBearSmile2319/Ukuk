//! Fechas impresas: formato, fechas imposibles y coherencia temporal.

use chrono::{Datelike, NaiveDate};
use serde_json::json;
use ukuk_core::{DocumentFields, DocumentType, Finding, Layer, Severity};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParsedDate {
    Valid(NaiveDate),
    /// Componentes numéricos reconocibles pero fecha inexistente (p. ej. 30 de febrero).
    Impossible { year: i32, month: u32, day: u32 },
    Unparseable,
}

/// Acepta `YYYY-MM-DD`, `YYYY/MM/DD`, `DD/MM/YYYY`, `DD-MM-YYYY` y `DD.MM.YYYY`
/// (opcionalmente seguido de una hora, que se ignora).
pub fn parse(s: &str) -> ParsedDate {
    let s = s.trim();
    let date_part = s.split(['T', ' ']).next().unwrap_or("");
    let parts: Vec<&str> = date_part.split(['-', '/', '.']).collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
        return ParsedDate::Unparseable;
    }
    let nums: Vec<u32> = match parts.iter().map(|p| p.parse::<u32>()).collect::<Result<_, _>>() {
        Ok(v) => v,
        Err(_) => return ParsedDate::Unparseable,
    };
    let (year, month, day) = if parts[0].len() == 4 {
        (nums[0], nums[1], nums[2])
    } else if parts[2].len() == 4 {
        (nums[2], nums[1], nums[0])
    } else {
        return ParsedDate::Unparseable;
    };
    let year = year as i32;
    match NaiveDate::from_ymd_opt(year, month, day) {
        Some(d) => ParsedDate::Valid(d),
        None => ParsedDate::Impossible { year, month, day },
    }
}

pub fn parse_valid(s: &str) -> Option<NaiveDate> {
    match parse(s) {
        ParsedDate::Valid(d) => Some(d),
        _ => None,
    }
}

/// Analiza un campo de fecha y, si no es válido, agrega el hallazgo correspondiente.
fn field_date(name: &str, raw: Option<&str>, out: &mut Vec<Finding>) -> Option<NaiveDate> {
    let raw = raw.map(str::trim).filter(|s| !s.is_empty())?;
    match parse(raw) {
        ParsedDate::Valid(d) => Some(d),
        ParsedDate::Impossible { year, month, day } => {
            out.push(
                Finding::new(
                    "dates.invalid_date",
                    Layer::Consistency,
                    Severity::High,
                    0.95,
                    format!("La fecha «{raw}» del campo {name} no existe en el calendario."),
                )
                .with_evidence(json!({ "field": name, "value": raw, "year": year, "month": month, "day": day })),
            );
            None
        }
        ParsedDate::Unparseable => {
            // Textos como "NO CADUCA" en DNI de mayores de 60 años son legítimos.
            if !raw.chars().any(|c| c.is_ascii_digit()) {
                return None;
            }
            out.push(
                Finding::new(
                    "dates.unparseable",
                    Layer::Extraction,
                    Severity::Low,
                    0.6,
                    format!("No se pudo interpretar la fecha «{raw}» del campo {name}."),
                )
                .with_evidence(json!({ "field": name, "value": raw })),
            );
            None
        }
    }
}

pub fn check(fields: &DocumentFields, document_type: Option<DocumentType>, today: NaiveDate) -> Vec<Finding> {
    let mut out = Vec::new();
    let issue = field_date("fecha_emision", fields.fecha_emision.as_deref(), &mut out);
    let expiry = field_date("fecha_vencimiento", fields.fecha_vencimiento.as_deref(), &mut out);
    let birth = field_date("fecha_nacimiento", fields.fecha_nacimiento.as_deref(), &mut out);

    if let Some(issue) = issue.filter(|d| *d > today) {
        out.push(
            Finding::new(
                "dates.future_issue",
                Layer::Consistency,
                Severity::High,
                0.9,
                format!("La fecha de emisión ({issue}) es posterior a la fecha actual ({today})."),
            )
            .with_evidence(json!({ "fecha_emision": issue.to_string(), "today": today.to_string() })),
        );
    }
    if let Some(birth) = birth.filter(|d| *d > today) {
        out.push(
            Finding::new(
                "dates.future_birth",
                Layer::Consistency,
                Severity::High,
                0.95,
                format!("La fecha de nacimiento ({birth}) es posterior a la fecha actual."),
            )
            .with_evidence(json!({ "fecha_nacimiento": birth.to_string(), "today": today.to_string() })),
        );
    }
    if let (Some(issue), Some(expiry)) = (issue, expiry)
        && expiry < issue
    {
        out.push(
            Finding::new(
                "dates.expiry_before_issue",
                Layer::Consistency,
                Severity::High,
                0.9,
                format!("La fecha de vencimiento ({expiry}) es anterior a la de emisión ({issue})."),
            )
            .with_evidence(json!({ "fecha_emision": issue.to_string(), "fecha_vencimiento": expiry.to_string() })),
        );
    }
    if let (Some(issue), Some(birth)) = (issue, birth)
        && birth > issue
    {
        out.push(
            Finding::new(
                "dates.birth_after_issue",
                Layer::Consistency,
                Severity::High,
                0.95,
                format!("La fecha de nacimiento ({birth}) es posterior a la de emisión ({issue})."),
            )
            .with_evidence(json!({ "fecha_emision": issue.to_string(), "fecha_nacimiento": birth.to_string() })),
        );
    }
    if let Some(birth) = birth.filter(|b| *b <= today && today.year() - b.year() > 120) {
        out.push(
            Finding::new(
                "dates.implausible_birth",
                Layer::Consistency,
                Severity::Medium,
                0.8,
                format!("La fecha de nacimiento ({birth}) implica una edad mayor a 120 años."),
            )
            .with_evidence(json!({ "fecha_nacimiento": birth.to_string() })),
        );
    }
    if document_type == Some(DocumentType::Dni)
        && let Some(expiry) = expiry.filter(|d| *d < today)
    {
        out.push(
            Finding::new(
                "dates.document_expired",
                Layer::Consistency,
                Severity::Medium,
                0.9,
                format!("El documento venció el {expiry}."),
            )
            .with_evidence(json!({ "fecha_vencimiento": expiry.to_string(), "today": today.to_string() })),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 13).unwrap()
    }

    fn codes(f: &[Finding]) -> Vec<&str> {
        f.iter().map(|f| f.code.as_str()).collect()
    }

    #[test]
    fn parses_formats() {
        let d = NaiveDate::from_ymd_opt(2026, 3, 15).unwrap();
        assert_eq!(parse("2026-03-15"), ParsedDate::Valid(d));
        assert_eq!(parse("15/03/2026"), ParsedDate::Valid(d));
        assert_eq!(parse("15-03-2026"), ParsedDate::Valid(d));
        assert_eq!(parse("15.03.2026"), ParsedDate::Valid(d));
        assert_eq!(parse("2026-03-15T10:00:00"), ParsedDate::Valid(d));
        assert_eq!(parse("2026/03/15"), ParsedDate::Valid(d));
    }

    #[test]
    fn impossible_and_unparseable() {
        assert_eq!(
            parse("2026-02-30"),
            ParsedDate::Impossible { year: 2026, month: 2, day: 30 }
        );
        assert!(matches!(parse("31/04/2025"), ParsedDate::Impossible { .. }));
        assert!(matches!(parse("2025-13-01"), ParsedDate::Impossible { .. }));
        assert_eq!(parse("ayer"), ParsedDate::Unparseable);
        assert_eq!(parse("15/03/26"), ParsedDate::Unparseable);
        assert!(matches!(parse("2024-02-29"), ParsedDate::Valid(_)));
    }

    #[test]
    fn detects_future_issue_and_impossible() {
        let f = DocumentFields {
            fecha_emision: Some("2027-01-01".into()),
            fecha_nacimiento: Some("2026-02-30".into()),
            ..Default::default()
        };
        let c = check(&f, None, today());
        assert_eq!(codes(&c), vec!["dates.invalid_date", "dates.future_issue"]);
    }

    #[test]
    fn detects_expiry_before_issue_and_birth_after_issue() {
        let f = DocumentFields {
            fecha_emision: Some("2020-05-10".into()),
            fecha_vencimiento: Some("2019-05-10".into()),
            fecha_nacimiento: Some("2021-01-01".into()),
            ..Default::default()
        };
        let c = check(&f, None, today());
        assert!(codes(&c).contains(&"dates.expiry_before_issue"));
        assert!(codes(&c).contains(&"dates.birth_after_issue"));
    }

    #[test]
    fn expired_dni_and_no_caduca() {
        let f = DocumentFields {
            fecha_vencimiento: Some("2024-01-01".into()),
            ..Default::default()
        };
        assert_eq!(codes(&check(&f, Some(DocumentType::Dni), today())), vec!["dates.document_expired"]);
        assert!(check(&f, Some(DocumentType::Factura), today()).is_empty());
        let f = DocumentFields {
            fecha_vencimiento: Some("NO CADUCA".into()),
            ..Default::default()
        };
        assert!(check(&f, Some(DocumentType::Dni), today()).is_empty());
    }

    #[test]
    fn unparseable_with_digits_is_reported() {
        let f = DocumentFields {
            fecha_emision: Some("15 de marzo 2026".into()),
            ..Default::default()
        };
        assert_eq!(codes(&check(&f, None, today())), vec!["dates.unparseable"]);
    }

    #[test]
    fn implausible_birth() {
        let f = DocumentFields {
            fecha_nacimiento: Some("1890-01-01".into()),
            ..Default::default()
        };
        assert_eq!(codes(&check(&f, None, today())), vec!["dates.implausible_birth"]);
    }
}
