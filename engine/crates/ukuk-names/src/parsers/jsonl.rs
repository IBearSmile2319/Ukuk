use crate::model::Entry;

use super::{ParseError, finish_entry};

pub fn parse(raw: &[u8]) -> Result<Vec<Entry>, ParseError> {
    let text = std::str::from_utf8(raw).map_err(|_| ParseError::Encoding)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let entry: Entry = serde_json::from_str(line).map_err(|e| ParseError::Jsonl {
            line: i + 1,
            message: e.to_string(),
        })?;
        if entry.id.trim().is_empty() {
            return Err(ParseError::Jsonl {
                line: i + 1,
                message: "falta el campo id".into(),
            });
        }
        if let Some(e) = finish_entry(entry) {
            out.push(e);
        }
    }
    Ok(out)
}
