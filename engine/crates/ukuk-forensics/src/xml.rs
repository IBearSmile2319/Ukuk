//! Comprobante electrónico SUNAT (UBL 2.x): Invoice, CreditNote, DebitNote.
//! Se extraen los datos clave y se comparan con los campos impresos del PDF.
//! La firma XMLDSig solo se detecta; no se valida criptográficamente.

use quick_xml::NsReader;
use quick_xml::events::Event;
use quick_xml::name::ResolveResult;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ukuk_core::{DocumentFields, Finding, Layer, Severity};
use ukuk_peru::{dates, invoice};

const UBL_NS_PREFIX: &str = "urn:oasis:names:specification:ubl:schema:xsd:";
const XMLDSIG_NS: &str = "http://www.w3.org/2000/09/xmldsig#";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct XmlReport {
    pub is_sunat_ubl: bool,
    pub has_signature: bool,
    pub ruc_emisor: Option<String>,
    pub serie_numero: Option<String>,
    pub total: Option<String>,
    pub fecha_emision: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct XmlAnalysis {
    pub report: XmlReport,
    pub findings: Vec<Finding>,
}

fn resolve_ref(r: &quick_xml::events::BytesRef<'_>) -> String {
    if let Ok(Some(c)) = r.resolve_char_ref() {
        return c.to_string();
    }
    match &**r {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        _ => "",
    }
    .to_string()
}

fn parse(raw: &[u8]) -> Result<XmlReport, String> {
    let mut reader = NsReader::from_reader(raw);
    let mut buf = Vec::new();
    let mut path: Vec<String> = Vec::new();
    let mut text = String::new();
    let mut report = XmlReport::default();
    let mut legacy_ruc: Option<String> = None;
    let mut saw_root = false;

    loop {
        let pos = reader.buffer_position();
        let (ns, ev) = reader
            .read_resolved_event_into(&mut buf)
            .map_err(|e| format!("XML inválido (cerca de la posición {pos}): {e}"))?;
        let ns_str = match &ns {
            ResolveResult::Bound(n) => n.as_ref().to_string(),
            _ => String::new(),
        };
        match ev {
            Event::Start(e) => {
                let local = e.local_name().as_ref().to_string();
                if !saw_root {
                    saw_root = true;
                    report.is_sunat_ubl =
                        matches!(local.as_str(), "Invoice" | "CreditNote" | "DebitNote")
                            && ns_str.starts_with(UBL_NS_PREFIX);
                }
                if local == "Signature" && ns_str == XMLDSIG_NS {
                    report.has_signature = true;
                }
                path.push(local);
                text.clear();
            }
            Event::Empty(e) => {
                let local = e.local_name().as_ref().to_string();
                if local == "Signature" && ns_str == XMLDSIG_NS {
                    report.has_signature = true;
                }
                if !saw_root {
                    saw_root = true;
                }
            }
            Event::Text(t) => text.push_str(&t),
            Event::CData(t) => text.push_str(&t),
            Event::GeneralRef(r) => text.push_str(&resolve_ref(&r)),
            Event::End(_) => {
                let value = text.trim().to_string();
                text.clear();
                let p: Vec<&str> = path.iter().skip(1).map(String::as_str).collect();
                if !value.is_empty() {
                    match p.as_slice() {
                        ["ID"] => report.serie_numero = Some(value),
                        ["IssueDate"] => report.fecha_emision = Some(value),
                        [
                            "LegalMonetaryTotal" | "RequestedMonetaryTotal",
                            "PayableAmount",
                        ] => {
                            report.total = Some(value);
                        }
                        [
                            "AccountingSupplierParty",
                            "Party",
                            "PartyIdentification",
                            "ID",
                        ] => {
                            report.ruc_emisor = Some(value);
                        }
                        ["AccountingSupplierParty", "CustomerAssignedAccountID"] => {
                            legacy_ruc = Some(value)
                        }
                        _ => {}
                    }
                }
                path.pop();
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    if !saw_root {
        return Err("XML vacío".into());
    }
    if report.ruc_emisor.is_none() {
        report.ruc_emisor = legacy_ruc;
    }
    Ok(report)
}

fn serie_key(s: &str) -> Option<(String, u64)> {
    let (serie, num) = s.trim().split_once('-')?;
    Some((serie.trim().to_ascii_uppercase(), num.trim().parse().ok()?))
}

fn mismatch(field: &str, xml: &str, printed: &str) -> Finding {
    Finding::new(
        "xml.mismatch_with_pdf",
        Layer::Consistency,
        Severity::High,
        0.9,
        format!(
            "El campo {field} del XML («{xml}») no coincide con el documento impreso («{printed}»)."
        ),
    )
    .with_evidence(json!({ "field": field, "xml": xml, "printed": printed }))
}

/// Compara el XML con los campos impresos (si se proporcionaron).
pub fn compare(report: &XmlReport, fields: &DocumentFields) -> Vec<Finding> {
    let mut out = Vec::new();
    if let (Some(x), Some(p)) = (&report.ruc_emisor, &fields.ruc_emisor)
        && x.trim() != p.trim()
    {
        out.push(mismatch("ruc_emisor", x, p));
    }
    if let (Some(x), Some(p)) = (&report.serie_numero, &fields.serie_numero) {
        let same = match (serie_key(x), serie_key(p)) {
            (Some(a), Some(b)) => a == b,
            _ => x.trim().eq_ignore_ascii_case(p.trim()),
        };
        if !same {
            out.push(mismatch("serie_numero", x, p));
        }
    }
    if let (Some(x), Some(p)) = (&report.total, &fields.total) {
        let same = match (invoice::parse_amount(x), invoice::parse_amount(p)) {
            (Some(a), Some(b)) => (a - b).abs() <= 0.01,
            _ => x.trim() == p.trim(),
        };
        if !same {
            out.push(mismatch("total", x, p));
        }
    }
    if let (Some(x), Some(p)) = (&report.fecha_emision, &fields.fecha_emision) {
        let same = match (dates::parse_valid(x), dates::parse_valid(p)) {
            (Some(a), Some(b)) => a == b,
            _ => x.trim() == p.trim(),
        };
        if !same {
            out.push(mismatch("fecha_emision", x, p));
        }
    }
    out
}

pub fn analyze_xml(raw: &[u8], fields: Option<&DocumentFields>) -> Result<XmlAnalysis, String> {
    let report = parse(raw)?;
    let mut findings = Vec::new();
    if !report.is_sunat_ubl {
        findings.push(Finding::new(
            "xml.not_sunat_ubl",
            Layer::Classification,
            Severity::Low,
            0.8,
            "El XML no es un comprobante electrónico UBL (Invoice, CreditNote o DebitNote).",
        ));
    } else if !report.has_signature {
        findings.push(Finding::new(
            "xml.unsigned",
            Layer::Forensics,
            Severity::Medium,
            0.8,
            "El comprobante electrónico no contiene firma digital (ds:Signature).",
        ));
    }
    if let Some(f) = fields {
        findings.extend(compare(&report, f));
    }
    Ok(XmlAnalysis { report, findings })
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const INVOICE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent>
    <ds:Signature Id="SignSUNAT"><ds:SignedInfo/><ds:SignatureValue>abc</ds:SignatureValue></ds:Signature>
  </ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:ID>F001-00001234</cbc:ID>
  <cbc:IssueDate>2026-03-15</cbc:IssueDate>
  <cac:Signature><cbc:ID>IDSignSUNAT</cbc:ID></cac:Signature>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="6">20100047218</cbc:ID></cac:PartyIdentification>
    <cac:PartyLegalEntity><cbc:RegistrationName><![CDATA[EMPRESA DEMO S.A.C.]]></cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="1">12345678</cbc:ID></cac:PartyIdentification>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="PEN">18.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="PEN">100.00</cbc:LineExtensionAmount><cbc:PayableAmount currencyID="PEN">118.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine><cbc:ID>1</cbc:ID></cac:InvoiceLine>
</Invoice>"#;

    #[test]
    fn extracts_ubl_invoice() {
        let a = analyze_xml(INVOICE.as_bytes(), None).unwrap();
        let r = &a.report;
        assert!(r.is_sunat_ubl);
        assert!(r.has_signature);
        assert_eq!(r.ruc_emisor.as_deref(), Some("20100047218"));
        assert_eq!(r.serie_numero.as_deref(), Some("F001-00001234"));
        assert_eq!(r.total.as_deref(), Some("118.00"));
        assert_eq!(r.fecha_emision.as_deref(), Some("2026-03-15"));
        assert!(a.findings.is_empty());
    }

    #[test]
    fn compares_with_printed_fields() {
        let fields = DocumentFields {
            ruc_emisor: Some("20100047218".into()),
            serie_numero: Some("F001-1234".into()),
            total: Some("118".into()),
            fecha_emision: Some("15/03/2026".into()),
            ..Default::default()
        };
        assert!(
            analyze_xml(INVOICE.as_bytes(), Some(&fields))
                .unwrap()
                .findings
                .is_empty()
        );
        let fields = DocumentFields {
            ruc_emisor: Some("20131312955".into()),
            serie_numero: Some("F001-1235".into()),
            total: Some("1180.00".into()),
            fecha_emision: Some("2026-03-16".into()),
            ..Default::default()
        };
        let a = analyze_xml(INVOICE.as_bytes(), Some(&fields)).unwrap();
        assert_eq!(a.findings.len(), 4);
        assert!(a.findings.iter().all(|f| f.code == "xml.mismatch_with_pdf"));
    }

    #[test]
    fn unsigned_and_non_ubl() {
        let unsigned = INVOICE.replace("<ds:Signature Id=\"SignSUNAT\"><ds:SignedInfo/><ds:SignatureValue>abc</ds:SignatureValue></ds:Signature>", "");
        let a = analyze_xml(unsigned.as_bytes(), None).unwrap();
        assert!(!a.report.has_signature);
        assert_eq!(a.findings[0].code, "xml.unsigned");
        let a = analyze_xml(b"<root><ID>1</ID></root>", None).unwrap();
        assert!(!a.report.is_sunat_ubl);
        assert_eq!(a.findings[0].code, "xml.not_sunat_ubl");
    }

    #[test]
    fn credit_note_and_legacy_ruc() {
        let xml = r#"<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:ID>FC01-77</cbc:ID><cac:AccountingSupplierParty><cbc:CustomerAssignedAccountID>20100047218</cbc:CustomerAssignedAccountID></cac:AccountingSupplierParty><cac:LegalMonetaryTotal><cbc:PayableAmount>50.00</cbc:PayableAmount></cac:LegalMonetaryTotal></CreditNote>"#;
        let a = analyze_xml(xml.as_bytes(), None).unwrap();
        assert!(a.report.is_sunat_ubl);
        assert_eq!(a.report.ruc_emisor.as_deref(), Some("20100047218"));
        assert_eq!(a.report.total.as_deref(), Some("50.00"));
    }

    #[test]
    fn invalid_xml() {
        assert!(analyze_xml(b"<a><b></a>", None).is_err());
        assert!(analyze_xml(b"", None).is_err());
        // Las entidades externas no se expanden (sin XXE).
        let xxe = br#"<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><Invoice><ID>&e;</ID></Invoice>"#;
        let r = analyze_xml(xxe, None).unwrap();
        assert_eq!(r.report.serie_numero, None);
    }
}
