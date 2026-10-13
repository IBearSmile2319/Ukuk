//! Índice invertido por clave fonética y búsqueda (individual y por lotes).

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::model::{Category, Entry, EntryKind, ListMeta};
use crate::normalize::{NameToken, PreparedName, prepare};
use crate::parsers::country_code;
use crate::score::{NameScore, score_tokens, token_similarity};

pub const DEFAULT_THRESHOLD: f64 = 0.85;
pub const DEFAULT_LIMIT: usize = 10;
const BIRTH_MATCH_BONUS: f64 = 0.03;
const BIRTH_MISMATCH_PENALTY: f64 = 0.15;
const KIND_MISMATCH_PENALTY: f64 = 0.05;

/// Nombre (principal o alias) indexado; sus tokens apuntan al vocabulario.
struct IndexedName {
    entry: u32,
    original: String,
    tokens: Vec<u32>,
}

/// Lista cargada con su índice invertido por clave fonética.
pub struct IndexedList {
    pub meta: ListMeta,
    entries: Vec<Entry>,
    names: Vec<IndexedName>,
    /// Tokens distintos de toda la lista (los apellidos se repiten mucho).
    vocab: Vec<NameToken>,
    postings: HashMap<String, Vec<u32>>,
}

thread_local! {
    /// Contadores densos reutilizables para la selección de candidatos.
    static COUNTS: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

impl std::fmt::Debug for IndexedList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndexedList")
            .field("meta", &self.meta)
            .field("names", &self.names.len())
            .field("vocab", &self.vocab.len())
            .field("keys", &self.postings.len())
            .finish()
    }
}

impl IndexedList {
    pub fn build(meta: ListMeta, entries: Vec<Entry>) -> Self {
        let prepared: Vec<(u32, String, PreparedName)> = entries
            .par_iter()
            .enumerate()
            .flat_map_iter(|(i, e)| {
                std::iter::once(&e.name)
                    .chain(e.aliases.iter())
                    .map(move |n| (i as u32, n.clone(), prepare(n)))
            })
            .collect();
        let mut vocab: Vec<NameToken> = Vec::new();
        let mut vocab_ids: HashMap<(String, Option<String>), u32> = HashMap::new();
        let mut postings: HashMap<String, Vec<u32>> = HashMap::new();
        let mut names = Vec::with_capacity(prepared.len());
        for (idx, (entry, original, p)) in prepared.into_iter().enumerate() {
            for key in blocking_keys(&p) {
                let list = postings.entry(key).or_default();
                if list.last() != Some(&(idx as u32)) {
                    list.push(idx as u32);
                }
            }
            let tokens = p
                .tokens
                .into_iter()
                .map(|t| {
                    *vocab_ids
                        .entry((t.text.clone(), t.compound.clone()))
                        .or_insert_with(|| {
                            vocab.push(t);
                            (vocab.len() - 1) as u32
                        })
                })
                .collect();
            names.push(IndexedName {
                entry,
                original,
                tokens,
            });
        }
        Self {
            meta,
            entries,
            names,
            vocab,
            postings,
        }
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// Nombres candidatos: comparten claves fonéticas con al menos la mitad de
    /// los tokens de la consulta.
    fn candidates(&self, q: &PreparedName) -> Vec<u32> {
        let keys = blocking_keys(q);
        let scoring_tokens = q.tokens.iter().filter(|t| !t.initial).count().max(1);
        let min_shared = scoring_tokens.div_ceil(2).min(keys.len().max(1)) as u32;
        COUNTS.with_borrow_mut(|counts| {
            counts.clear();
            counts.resize(self.names.len(), 0);
            let mut out = Vec::new();
            for k in &keys {
                if let Some(list) = self.postings.get(k) {
                    for &idx in list {
                        let c = &mut counts[idx as usize];
                        *c = c.saturating_add(1);
                        if u32::from(*c) == min_shared {
                            out.push(idx);
                        }
                    }
                }
            }
            out.sort_unstable();
            out
        })
    }
}

/// Claves de bloqueo de un nombre: clave fonética de cada token (y de su forma
/// compuesta). Las iniciales no se indexan.
fn blocking_keys(p: &PreparedName) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for t in p.tokens.iter().filter(|t| !t.initial) {
        keys.push(t.key.clone());
        if let Some(ck) = &t.compound_key {
            keys.push(ck.clone());
        }
    }
    keys.sort();
    keys.dedup();
    keys
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ScreenQuery {
    pub name: String,
    #[serde(default)]
    pub kind: Option<EntryKind>,
    #[serde(default)]
    pub birth_date: Option<String>,
    #[serde(default)]
    pub nationality: Option<String>,
    #[serde(default)]
    pub threshold: Option<f64>,
    #[serde(default)]
    pub sources: Option<Vec<String>>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScreenMatch {
    pub source: String,
    pub category: Category,
    pub entry_id: String,
    pub name: String,
    pub matched_name: String,
    pub score: f64,
    pub kind: Option<EntryKind>,
    pub programs: Vec<String>,
    pub birth_dates: Vec<String>,
    pub nationalities: Vec<String>,
    pub reasons: Vec<String>,
}

#[derive(PartialEq)]
enum BirthCheck {
    Equal,
    YearEqual,
    Different,
    Unknown,
}

fn birth_check(query: &str, entry_dates: &[String]) -> BirthCheck {
    let q = query.trim();
    if q.len() < 4 || entry_dates.is_empty() {
        return BirthCheck::Unknown;
    }
    let mut best = BirthCheck::Different;
    for d in entry_dates {
        let d = d.trim();
        if d.len() < 4 {
            continue;
        }
        if q.len() >= 10 && d.len() >= 10 {
            if q[..10] == d[..10] {
                return BirthCheck::Equal;
            }
        } else if q.len() >= 7 && d.len() >= 7 && q[..7] != d[..7] {
            continue;
        } else if q[..4] == d[..4] {
            best = BirthCheck::YearEqual;
        }
    }
    best
}

fn same_nationality(q: &str, list: &[String]) -> bool {
    let qc = country_code(q);
    list.iter()
        .any(|n| n.eq_ignore_ascii_case(q) || (qc.is_some() && country_code(n) == qc))
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

/// Busca un nombre en las listas indicadas.
pub fn screen(lists: &[Arc<IndexedList>], query: &ScreenQuery) -> Vec<ScreenMatch> {
    let threshold = query.threshold.unwrap_or(DEFAULT_THRESHOLD);
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    let prepared = prepare(&query.name);
    if prepared.tokens.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for list in lists {
        if let Some(sources) = &query.sources
            && !sources.iter().any(|s| s == &list.meta.source)
        {
            continue;
        }
        // Mejor variante (nombre o alias) por entrada; similitudes por token cacheadas.
        let mut best: HashMap<u32, (f64, u32, NameScore)> = HashMap::new();
        let mut cache: HashMap<u32, Vec<(f64, f64)>> = HashMap::new();
        for idx in list.candidates(&prepared) {
            let n = &list.names[idx as usize];
            let ctoks: Vec<&NameToken> =
                n.tokens.iter().map(|t| &list.vocab[*t as usize]).collect();
            for &t in &n.tokens {
                cache.entry(t).or_insert_with(|| {
                    let ct = &list.vocab[t as usize];
                    prepared
                        .tokens
                        .iter()
                        .map(|q| token_similarity(q, ct))
                        .collect()
                });
            }
            let s = score_tokens(&prepared.tokens, &ctoks, |i, j| cache[&n.tokens[j]][i]);
            let slot = best.entry(n.entry).or_insert((-1.0, idx, s));
            if s.score > slot.0 {
                *slot = (s.score, idx, s);
            }
        }
        for (entry_idx, (_, name_idx, s)) in best {
            let entry = &list.entries[entry_idx as usize];
            let mut score = s.score;
            let mut reasons = vec![
                format!("tokens: {}/{}", s.matched, s.query_tokens),
                format!("jaro_winkler: {:.2}", s.mean_similarity),
            ];
            if let Some(b) = query.birth_date.as_deref() {
                match birth_check(b, &entry.birth_dates) {
                    BirthCheck::Equal => {
                        score += BIRTH_MATCH_BONUS;
                        reasons.push("fecha de nacimiento coincide".into());
                    }
                    BirthCheck::YearEqual => {
                        score += BIRTH_MATCH_BONUS;
                        reasons.push("año de nacimiento coincide".into());
                    }
                    BirthCheck::Different => {
                        score -= BIRTH_MISMATCH_PENALTY;
                        reasons.push("fecha de nacimiento distinta".into());
                    }
                    BirthCheck::Unknown => {}
                }
            }
            if let (Some(qk), Some(ek)) = (query.kind, entry.kind)
                && qk != ek
            {
                score -= KIND_MISMATCH_PENALTY;
                reasons.push(format!("tipo distinto ({} / {})", qk.as_str(), ek.as_str()));
            }
            if let Some(n) = query.nationality.as_deref()
                && same_nationality(n, &entry.nationalities)
            {
                reasons.push("nacionalidad coincide".into());
            }
            let score = round4(score.clamp(0.0, 1.0));
            if score < threshold {
                continue;
            }
            out.push(ScreenMatch {
                source: list.meta.source.clone(),
                category: list.meta.category,
                entry_id: entry.id.clone(),
                name: entry.name.clone(),
                matched_name: list.names[name_idx as usize].original.clone(),
                score,
                kind: entry.kind,
                programs: entry.programs.clone(),
                birth_dates: entry.birth_dates.clone(),
                nationalities: entry.nationalities.clone(),
                reasons,
            });
        }
    }
    out.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.source.cmp(&b.source))
            .then_with(|| a.entry_id.cmp(&b.entry_id))
    });
    out.truncate(limit);
    out
}

/// Búsqueda por lotes en paralelo; conserva el orden de entrada.
pub fn screen_batch(lists: &[Arc<IndexedList>], queries: &[ScreenQuery]) -> Vec<Vec<ScreenMatch>> {
    queries.par_iter().map(|q| screen(lists, q)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(source: &str) -> ListMeta {
        ListMeta {
            source: source.into(),
            category: Category::Sanction,
            entries: 0,
            version: "v".into(),
            loaded_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn entry(id: &str, name: &str, aliases: &[&str], kind: EntryKind, dob: &[&str]) -> Entry {
        Entry {
            id: id.into(),
            name: name.into(),
            aliases: aliases.iter().map(|s| s.to_string()).collect(),
            kind: Some(kind),
            birth_dates: dob.iter().map(|s| s.to_string()).collect(),
            nationalities: vec!["PE".into()],
            programs: vec!["SDNTK".into()],
            remarks: None,
        }
    }

    fn list() -> Arc<IndexedList> {
        Arc::new(IndexedList::build(
            meta("test"),
            vec![
                entry(
                    "1",
                    "PEREZ DE LA CRUZ, Juan",
                    &["EL CHATO"],
                    EntryKind::Individual,
                    &["1970-02-03"],
                ),
                entry(
                    "2",
                    "QUISPE MAMANI, Rosa Elvira",
                    &[],
                    EntryKind::Individual,
                    &["1965"],
                ),
                entry(
                    "3",
                    "INVERSIONES EL DORADO S.A.C.",
                    &[],
                    EntryKind::Entity,
                    &[],
                ),
                entry(
                    "4",
                    "VASQUEZ HUAMAN, Wilber",
                    &[],
                    EntryKind::Individual,
                    &[],
                ),
            ],
        ))
    }

    fn q(name: &str) -> ScreenQuery {
        ScreenQuery {
            name: name.into(),
            ..Default::default()
        }
    }

    #[test]
    fn finds_reordered_name_with_particles() {
        let mut query = q("Juan Carlos Pérez de la Cruz");
        query.birth_date = Some("1970-02-03".into());
        query.nationality = Some("Perú".into());
        let m = screen(&[list()], &query);
        assert_eq!(m.len(), 1, "{m:?}");
        assert_eq!(m[0].entry_id, "1");
        assert!(
            m[0].reasons
                .iter()
                .any(|r| r == "fecha de nacimiento coincide")
        );
        assert!(m[0].reasons.iter().any(|r| r == "nacionalidad coincide"));
        assert!(m[0].score > 0.88);
    }

    #[test]
    fn birth_date_penalty() {
        let base = screen(&[list()], &q("Rosa Elvira Quispe Mamani"));
        assert_eq!(base[0].score, 1.0);
        let mut query = q("Rosa Elvira Quispe Mamani");
        query.birth_date = Some("1980-01-01".into());
        query.threshold = Some(0.5);
        let m = screen(&[list()], &query);
        assert!((m[0].score - 0.85).abs() < 1e-9);
        query.birth_date = Some("1965-07-07".into());
        let m = screen(&[list()], &query);
        assert_eq!(m[0].score, 1.0);
        assert!(
            m[0].reasons
                .iter()
                .any(|r| r == "año de nacimiento coincide")
        );
    }

    #[test]
    fn alias_and_phonetic_match() {
        let m = screen(&[list()], &q("El Chato"));
        assert_eq!(m[0].entry_id, "1");
        assert_eq!(m[0].matched_name, "EL CHATO");
        let m = screen(&[list()], &q("Wilber Basques Uaman"));
        assert_eq!(m[0].entry_id, "4");
    }

    #[test]
    fn kind_mismatch_penalty() {
        let mut query = q("Inversiones El Dorado SAC");
        query.kind = Some(EntryKind::Individual);
        query.threshold = Some(0.5);
        let m = screen(&[list()], &query);
        assert!((m[0].score - 0.95).abs() < 1e-9, "{m:?}");
    }

    #[test]
    fn source_filter_threshold_and_limit() {
        let mut query = q("Juan Pérez de la Cruz");
        query.sources = Some(vec!["otra".into()]);
        assert!(screen(&[list()], &query).is_empty());
        let mut query = q("María Torres");
        assert!(screen(&[list()], &query).is_empty());
        query.limit = Some(0);
        assert!(screen(&[list()], &query).is_empty());
    }

    #[test]
    fn batch_preserves_order() {
        let r = screen_batch(
            &[list()],
            &[
                q("Rosa Quispe Mamani"),
                q("Nadie"),
                q("Wilber Vasquez Huaman"),
            ],
        );
        assert_eq!(r.len(), 3);
        assert_eq!(r[0][0].entry_id, "2");
        assert!(r[1].is_empty());
        assert_eq!(r[2][0].entry_id, "4");
    }

    #[test]
    fn birth_check_rules() {
        let d = vec!["1960-01-01".to_string(), "1962".to_string()];
        assert!(birth_check("1960-01-01", &d) == BirthCheck::Equal);
        assert!(birth_check("1962-05-05", &d) == BirthCheck::YearEqual);
        assert!(birth_check("1961-05-05", &d) == BirthCheck::Different);
        assert!(birth_check("1960-01-01", &[]) == BirthCheck::Unknown);
        assert!(birth_check("1960-02", &["1960-03".to_string()]) == BirthCheck::Different);
    }
}
