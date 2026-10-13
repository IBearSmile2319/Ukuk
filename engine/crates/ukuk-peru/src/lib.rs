//! Reglas peruanas puras y deterministas. Ninguna función consulta el reloj:
//! la fecha de referencia (`today`) siempre se recibe como parámetro.

pub mod dates;
pub mod dni;
pub mod invoice;
pub mod mrz;
pub mod ruc;
pub mod text;

use chrono::NaiveDate;
use ukuk_core::{DocumentFields, DocumentType, Finding};

pub use mrz::{MrzAnalysis, MrzChecks, MrzData};
pub use ruc::{RucKind, RucValidation};

/// Ejecuta todas las reglas sobre los campos impresos (excepto MRZ, que se
/// analiza aparte porque produce su propio objeto de respuesta).
pub fn check_fields(
    fields: &DocumentFields,
    document_type: Option<DocumentType>,
    today: NaiveDate,
) -> Vec<Finding> {
    let mut out = Vec::new();
    if let Some(ruc) = fields
        .ruc_emisor
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        out.extend(ruc::findings(ruc));
    }
    if let Some(dni) = fields.dni.as_deref().filter(|s| !s.trim().is_empty()) {
        out.extend(dni::findings(dni));
    }
    out.extend(invoice::check(fields, document_type));
    out.extend(dates::check(fields, document_type, today));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_fields_combines_rules() {
        let fields = DocumentFields {
            ruc_emisor: Some("20100047219".into()),
            subtotal: Some("100.00".into()),
            igv: Some("18.00".into()),
            total: Some("120.00".into()),
            fecha_emision: Some("2026-02-30".into()),
            ..Default::default()
        };
        let today = NaiveDate::from_ymd_opt(2026, 10, 13).unwrap();
        let codes: Vec<_> = check_fields(&fields, Some(DocumentType::Factura), today)
            .into_iter()
            .map(|f| f.code)
            .collect();
        assert!(codes.contains(&"ruc.invalid".to_string()));
        assert!(codes.contains(&"invoice.totals_mismatch".to_string()));
        assert!(codes.contains(&"dates.invalid_date".to_string()));
    }

    #[test]
    fn clean_fields_produce_no_findings() {
        let fields = DocumentFields {
            ruc_emisor: Some("20100047218".into()),
            serie_numero: Some("F001-00001234".into()),
            subtotal: Some("100.00".into()),
            igv: Some("18.00".into()),
            total: Some("118.00".into()),
            items_total: Some("100.00".into()),
            fecha_emision: Some("2026-03-15".into()),
            ..Default::default()
        };
        let today = NaiveDate::from_ymd_opt(2026, 10, 13).unwrap();
        let f = check_fields(&fields, Some(DocumentType::Factura), today);
        assert!(f.is_empty(), "{f:?}");
    }
}
