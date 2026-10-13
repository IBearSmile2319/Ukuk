//! OFAC SDN (`sdn.csv`): sin cabecera, 12 columnas, "-0-" como vacío.
//! Las observaciones contienen fechas de nacimiento, nacionalidad y alias.

use std::sync::LazyLock;

use regex::Regex;

use crate::model::{Entry, EntryKind};

use super::{ParseError, countries::country_code, finish_entry};

static ALIAS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\b[af]\.k\.a\.,?\s*['"‘’“”]([^'"‘’“”]+)['"‘’“”]"#).unwrap());
static DOB_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:circa\s+)?(?:(\d{1,2})\s+)?(?:([A-Z]{3})[a-z]*\s+)?(\d{4})").unwrap()
});

fn clean(v: Option<&str>) -> Option<String> {
    let v = v?.trim().trim_matches('\u{1a}').trim();
    (!v.is_empty() && v != "-0-").then(|| v.to_string())
}

fn month(m: &str) -> Option<u32> {
    let months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    months.iter().position(|x| x.eq_ignore_ascii_case(m)).map(|i| i as u32 + 1)
}

/// "01 Jan 1960" → "1960-01-01"; "Jan 1960" → "1960-01"; "circa 1960" → "1960".
pub fn parse_dob(s: &str) -> Option<String> {
    let c = DOB_RE.captures(s.trim())?;
    let year = c.get(3)?.as_str();
    let mon = c.get(2).and_then(|m| month(m.as_str()));
    let day = c.get(1).and_then(|d| d.as_str().parse::<u32>().ok());
    Some(match (mon, day) {
        (Some(m), Some(d)) => format!("{year}-{m:02}-{d:02}"),
        (Some(m), None) => format!("{year}-{m:02}"),
        _ => year.to_string(),
    })
}

/// Extrae (fechas, nacionalidades, alias) de las observaciones.
pub fn parse_remarks(remarks: &str) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut dobs = Vec::new();
    let mut nats = Vec::new();
    for seg in remarks.split(';') {
        let seg = seg.trim().trim_end_matches('.');
        let lower = seg.to_ascii_lowercase();
        let lower = lower.strip_prefix("alt. ").unwrap_or(&lower);
        let offset = seg.len() - lower.len();
        if let Some(rest) = lower.strip_prefix("dob ") {
            let rest = &seg[seg.len() - rest.len()..];
            // Rangos "1958 to 1962": se registran ambos extremos como años.
            for part in rest.split(" to ") {
                dobs.extend(parse_dob(part));
            }
        } else if lower.starts_with("nationality ") {
            let v = seg[offset + "nationality ".len()..].trim();
            nats.push(country_code(v).map_or_else(|| v.to_string(), str::to_string));
        }
    }
    let aliases = ALIAS_RE
        .captures_iter(remarks)
        .filter_map(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .collect();
    (dobs, nats, aliases)
}

pub fn parse(raw: &[u8]) -> Result<Vec<Entry>, ParseError> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .trim(csv::Trim::None)
        .from_reader(raw);
    let mut out = Vec::new();
    for rec in reader.records() {
        let rec = rec.map_err(|e| ParseError::Csv(e.to_string()))?;
        let Some(id) = clean(rec.get(0)) else { continue };
        if id.eq_ignore_ascii_case("ent_num") || rec.len() < 2 {
            continue;
        }
        let Some(name) = clean(rec.get(1)) else { continue };
        let sdn_type = clean(rec.get(2)).unwrap_or_default().to_ascii_lowercase();
        let kind = if sdn_type == "individual" {
            EntryKind::Individual
        } else {
            EntryKind::Entity
        };
        let programs = clean(rec.get(3))
            .map(|p| {
                p.split("] [")
                    .map(|s| s.trim_matches(|c: char| c == '[' || c == ']' || c.is_whitespace()).to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let remarks = clean(rec.get(11));
        let (birth_dates, nationalities, aliases) =
            remarks.as_deref().map(parse_remarks).unwrap_or_default();
        let remarks = match sdn_type.as_str() {
            "vessel" | "aircraft" => Some(format!("[{sdn_type}] {}", remarks.unwrap_or_default())),
            _ => remarks,
        };
        out.extend(finish_entry(Entry {
            id,
            name,
            aliases,
            kind: Some(kind),
            birth_dates,
            nationalities,
            programs,
            remarks,
        }));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dob_formats() {
        assert_eq!(parse_dob("01 Jan 1960").as_deref(), Some("1960-01-01"));
        assert_eq!(parse_dob("Mar 1971").as_deref(), Some("1971-03"));
        assert_eq!(parse_dob("circa 1955").as_deref(), Some("1955"));
        assert_eq!(parse_dob("1949").as_deref(), Some("1949"));
        assert_eq!(parse_dob("unknown"), None);
    }

    #[test]
    fn remarks() {
        let (d, n, a) = parse_remarks(
            "DOB 03 Feb 1970; alt. DOB 1971; POB Lima, Peru; nationality Peru; a.k.a. 'EL TIO'; a.k.a. 'TIO JUAN'.",
        );
        assert_eq!(d, vec!["1970-02-03", "1971"]);
        assert_eq!(n, vec!["PE"]);
        assert_eq!(a, vec!["EL TIO", "TIO JUAN"]);
        let (d, _, _) = parse_remarks("DOB 1958 to 1962");
        assert_eq!(d, vec!["1958", "1962"]);
    }
}
