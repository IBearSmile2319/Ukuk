//! Lista consolidada del Consejo de Seguridad de la ONU (XML).

use quick_xml::Reader;
use quick_xml::events::Event;

use crate::model::{Entry, EntryKind};

use super::{ParseError, countries::country_code, finish_entry, resolve_xml_ref};

#[derive(Default)]
struct Builder {
    entry: Entry,
    names: [String; 4],
    reference: Option<String>,
}

pub fn parse(raw: &[u8]) -> Result<Vec<Entry>, ParseError> {
    let mut reader = Reader::from_reader(raw);
    // Sin recorte: los textos llegan partidos alrededor de las referencias (&amp;).
    let mut buf = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut text = String::new();
    let mut current: Option<Builder> = None;
    let mut out = Vec::new();

    loop {
        let ev = reader
            .read_event_into(&mut buf)
            .map_err(|e| ParseError::Xml(format!("posición {}: {e}", reader.buffer_position())))?;
        match ev {
            Event::Start(e) => {
                let name = e.local_name().as_ref().to_ascii_uppercase();
                if name == "INDIVIDUAL" || name == "ENTITY" {
                    let mut b = Builder::default();
                    b.entry.kind = Some(if name == "INDIVIDUAL" {
                        EntryKind::Individual
                    } else {
                        EntryKind::Entity
                    });
                    current = Some(b);
                }
                stack.push(name);
                text.clear();
            }
            Event::Text(t) => text.push_str(&t),
            Event::CData(t) => text.push_str(&t),
            Event::GeneralRef(r) => text.extend(resolve_xml_ref(&r)),
            Event::End(_) => {
                let name = stack.pop().unwrap_or_default();
                let parent = stack.last().map(String::as_str).unwrap_or("");
                let value = text.trim().to_string();
                text.clear();
                if name == "INDIVIDUAL" || name == "ENTITY" {
                    if let Some(b) = current.take() {
                        out.extend(build(b));
                    }
                    continue;
                }
                let Some(b) = current.as_mut() else { continue };
                if value.is_empty() {
                    continue;
                }
                assign(b, &name, parent, value);
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

fn assign(b: &mut Builder, name: &str, parent: &str, value: String) {
    let e = &mut b.entry;
    match (parent, name) {
        ("INDIVIDUAL" | "ENTITY", "DATAID") => e.id = value,
        ("INDIVIDUAL" | "ENTITY", "FIRST_NAME") => b.names[0] = value,
        ("INDIVIDUAL" | "ENTITY", "SECOND_NAME") => b.names[1] = value,
        ("INDIVIDUAL" | "ENTITY", "THIRD_NAME") => b.names[2] = value,
        ("INDIVIDUAL" | "ENTITY", "FOURTH_NAME") => b.names[3] = value,
        ("INDIVIDUAL" | "ENTITY", "UN_LIST_TYPE") => e.programs.push(value),
        ("INDIVIDUAL" | "ENTITY", "REFERENCE_NUMBER") => b.reference = Some(value),
        ("INDIVIDUAL" | "ENTITY", "COMMENTS1") => e.remarks = Some(value),
        ("NATIONALITY", "VALUE") => e
            .nationalities
            .push(country_code(&value).map_or(value, str::to_string)),
        ("INDIVIDUAL_ALIAS" | "ENTITY_ALIAS", "ALIAS_NAME") => e.aliases.push(value),
        ("INDIVIDUAL_DATE_OF_BIRTH", "DATE") => {
            e.birth_dates.push(value.chars().take(10).collect());
        }
        ("INDIVIDUAL_DATE_OF_BIRTH", "YEAR" | "FROM_YEAR" | "TO_YEAR") => e.birth_dates.push(value),
        _ => {}
    }
}

fn build(b: Builder) -> Option<Entry> {
    let mut e = b.entry;
    e.name = b
        .names
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
    if let Some(r) = b.reference {
        e.remarks = Some(match e.remarks {
            Some(c) => format!("{r}: {c}"),
            None => r,
        });
    }
    if e.id.is_empty() {
        return None;
    }
    finish_entry(e)
}
