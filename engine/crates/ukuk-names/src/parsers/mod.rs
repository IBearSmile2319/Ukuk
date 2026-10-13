//! Parsers de listas de vigilancia: OFAC SDN CSV, ONU XML consolidado y `ukuk_jsonl`.

mod countries;
mod jsonl;
mod ofac;
mod un;

use thiserror::Error;

use crate::model::{Entry, ListFormat};

pub use countries::country_code;

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("CSV inválido: {0}")]
    Csv(String),
    #[error("XML inválido: {0}")]
    Xml(String),
    #[error("línea {line}: {message}")]
    Jsonl { line: usize, message: String },
    #[error("el archivo no es UTF-8 válido")]
    Encoding,
    #[error("la lista no contiene entradas")]
    Empty,
}

/// Interpreta el archivo crudo según el formato indicado.
pub fn parse(format: ListFormat, raw: &[u8]) -> Result<Vec<Entry>, ParseError> {
    let entries = match format {
        ListFormat::OfacSdnCsv => ofac::parse(raw)?,
        ListFormat::UnXml => un::parse(raw)?,
        ListFormat::UkukJsonl => jsonl::parse(raw)?,
    };
    if entries.is_empty() {
        return Err(ParseError::Empty);
    }
    Ok(entries)
}

/// Resuelve referencias XML (`&amp;`, `&#209;`) emitidas como eventos aparte.
pub(crate) fn resolve_xml_ref(r: &quick_xml::events::BytesRef<'_>) -> Option<String> {
    if let Ok(Some(c)) = r.resolve_char_ref() {
        return Some(c.to_string());
    }
    let s = match &**r {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        _ => return None,
    };
    Some(s.to_string())
}

fn dedup_keep_order(v: &mut Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    v.retain(|s| seen.insert(s.to_uppercase()));
}

pub(crate) fn finish_entry(mut e: Entry) -> Option<Entry> {
    e.name = e.name.split_whitespace().collect::<Vec<_>>().join(" ");
    if e.name.is_empty() {
        return None;
    }
    e.aliases = e
        .aliases
        .into_iter()
        .map(|a| a.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|a| !a.is_empty() && !a.eq_ignore_ascii_case(&e.name))
        .collect();
    dedup_keep_order(&mut e.aliases);
    dedup_keep_order(&mut e.birth_dates);
    dedup_keep_order(&mut e.nationalities);
    dedup_keep_order(&mut e.programs);
    Some(e)
}
