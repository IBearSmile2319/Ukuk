use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Individual,
    #[serde(alias = "organization", alias = "vessel", alias = "aircraft")]
    Entity,
}

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Individual => "individual",
            Self::Entity => "entity",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    #[default]
    Sanction,
    Pep,
    Interest,
}

impl Category {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "sanction" => Some(Self::Sanction),
            "pep" => Some(Self::Pep),
            "interest" => Some(Self::Interest),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListFormat {
    OfacSdnCsv,
    UnXml,
    UkukJsonl,
}

impl ListFormat {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ofac_sdn_csv" => Some(Self::OfacSdnCsv),
            "un_xml" => Some(Self::UnXml),
            "ukuk_jsonl" => Some(Self::UkukJsonl),
            _ => None,
        }
    }
}

/// Entrada de una lista de vigilancia (formato `ukuk_jsonl`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Entry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub kind: Option<EntryKind>,
    #[serde(default)]
    pub birth_dates: Vec<String>,
    #[serde(default)]
    pub nationalities: Vec<String>,
    #[serde(default)]
    pub programs: Vec<String>,
    #[serde(default)]
    pub remarks: Option<String>,
}

/// Metadatos públicos de una lista cargada (respuesta de `PUT/GET /v1/watchlists`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ListMeta {
    pub source: String,
    pub category: Category,
    pub entries: usize,
    pub version: String,
    pub loaded_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ListFormat>,
}
