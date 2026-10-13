//! Normalización de nombres: mayúsculas, sin tildes, sin signos, partículas aparte.

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

use crate::phonetic;

/// Partículas que se conservan para mostrar pero no puntúan por sí solas.
pub const PARTICLES: &[&str] = &["DE", "DEL", "LA", "LAS", "LOS", "Y", "VDA", "VIUDA", "E"];
/// Formas societarias que no identifican a la entidad (se comparan ya unidas: "S A C" → "SAC").
const LEGAL_SUFFIXES: &[&str] = &[
    "SAC", "SA", "SAA", "SRL", "EIRL", "SCRL", "SAS", "SL", "LTDA", "LTD", "INC", "LLC", "CORP",
    "CO", "GMBH", "PLC",
];
/// Partículas que forman apellidos compuestos ("DE LA CRUZ" ≈ "DELACRUZ").
const JOINABLE: &[&str] = &["DE", "DEL", "LA", "LAS", "LOS"];

/// Mayúsculas, descomposición NFD sin marcas (Ñ→N), signos eliminados y espacios colapsados.
pub fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for c in s.nfd().filter(|c| !is_combining_mark(*c)) {
        if c.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.extend(c.to_uppercase());
        } else if matches!(c, '\'' | '’' | '`' | '´') {
            // D'ANGELO → DANGELO
        } else {
            pending_space = true;
        }
    }
    out
}

/// Si el nombre viene como "APELLIDOS, Nombres" lo reordena a "Nombres APELLIDOS".
pub fn uncomma(s: &str) -> String {
    match s.split_once(',') {
        Some((last, first)) if !first.contains(',') && !first.trim().is_empty() => {
            format!("{} {}", first.trim(), last.trim())
        }
        _ => s.to_string(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NameToken {
    pub text: String,
    /// Forma unida con las partículas previas ("DELACRUZ").
    pub compound: Option<String>,
    pub key: String,
    pub compound_key: Option<String>,
    pub initial: bool,
}

impl NameToken {
    fn new(text: &str, prefix: &str) -> Self {
        let compound = (!prefix.is_empty()).then(|| format!("{prefix}{text}"));
        Self {
            key: phonetic::key(text),
            compound_key: compound.as_deref().map(phonetic::key),
            compound,
            initial: text.chars().count() == 1,
            text: text.to_string(),
        }
    }

    pub fn weight(&self) -> f64 {
        if self.initial {
            1.0
        } else {
            self.text.chars().count() as f64
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedName {
    /// Nombre normalizado completo (con partículas), en orden "nombres apellidos".
    pub normalized: String,
    /// Tokens que puntúan (sin partículas).
    pub tokens: Vec<NameToken>,
}

/// Prepara un nombre para puntuar: normaliza, reordena la forma con coma y separa partículas.
pub fn prepare(name: &str) -> PreparedName {
    let normalized = normalize(&uncomma(name));
    let mut words: Vec<&str> = normalized.split(' ').filter(|w| !w.is_empty()).collect();
    strip_legal_suffix(&mut words);
    let mut tokens = Vec::new();
    let mut prefix = String::new();
    for w in &words {
        if PARTICLES.contains(w) {
            if JOINABLE.contains(w) {
                prefix.push_str(w);
            } else {
                prefix.clear();
            }
            continue;
        }
        tokens.push(NameToken::new(w, &prefix));
        prefix.clear();
    }
    if tokens.is_empty() {
        // Nombre formado solo por partículas: se puntúan tal cual.
        tokens = words.iter().map(|w| NameToken::new(w, "")).collect();
    }
    PreparedName { normalized, tokens }
}

/// Quita la forma societaria final ("INVERSIONES X S.A.C." → "INVERSIONES X").
fn strip_legal_suffix(words: &mut Vec<&str>) {
    if words.len() < 2 {
        return;
    }
    for take in (1..=4.min(words.len() - 1)).rev() {
        let tail = &words[words.len() - take..];
        if take > 1 && tail.iter().any(|w| w.len() > 1) {
            continue;
        }
        if LEGAL_SUFFIXES.contains(&tail.concat().as_str()) {
            words.truncate(words.len() - take);
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        assert_eq!(normalize("  José   Muñoz-Pérez  "), "JOSE MUNOZ PEREZ");
        assert_eq!(normalize("D'Ángelo, María."), "DANGELO MARIA");
        assert_eq!(normalize("Ñañez"), "NANEZ");
    }

    #[test]
    fn comma_form() {
        assert_eq!(
            prepare("PEREZ DE LA CRUZ, Juan").normalized,
            "JUAN PEREZ DE LA CRUZ"
        );
        assert_eq!(uncomma("A, B, C"), "A, B, C");
    }

    #[test]
    fn particles_and_compounds() {
        let p = prepare("Juan Carlos Pérez de la Cruz");
        let texts: Vec<_> = p.tokens.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts, vec!["JUAN", "CARLOS", "PEREZ", "CRUZ"]);
        assert_eq!(p.tokens[3].compound.as_deref(), Some("DELACRUZ"));
        let p = prepare("Rosa Quispe Vda. de Mamani");
        let texts: Vec<_> = p.tokens.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts, vec!["ROSA", "QUISPE", "MAMANI"]);
        assert_eq!(p.tokens[2].compound.as_deref(), Some("DEMAMANI"));
        let p = prepare("Pérez y García");
        assert_eq!(p.tokens.len(), 2);
        assert!(p.tokens[1].compound.is_none());
    }

    #[test]
    fn only_particles() {
        let p = prepare("De La");
        assert_eq!(p.tokens.len(), 2);
    }

    #[test]
    fn legal_suffixes() {
        let p = prepare("Inversiones El Dorado S.A.C.");
        let texts: Vec<_> = p.tokens.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts, vec!["INVERSIONES", "EL", "DORADO"]);
        assert_eq!(p.normalized, "INVERSIONES EL DORADO S A C");
        let p = prepare("Minera Andina SAC");
        assert_eq!(p.tokens.len(), 2);
        let p = prepare("SA");
        assert_eq!(p.tokens.len(), 1);
    }

    #[test]
    fn initials() {
        let p = prepare("J. Pérez");
        assert!(p.tokens[0].initial);
        assert!(!p.tokens[1].initial);
    }
}
