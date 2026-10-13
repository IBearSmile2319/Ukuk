//! Puntaje de similitud entre dos nombres preparados: asignación de tokens sin
//! orden (Jaro-Winkler por token), penalización de tokens sobrantes por longitud.

use strsim::{jaro_winkler, normalized_damerau_levenshtein};

use crate::normalize::{NameToken, PreparedName};

/// Similitud mínima para considerar que dos tokens se corresponden.
const MIN_TOKEN_SIM: f64 = 0.80;
/// Similitud asignada a una inicial que coincide con la primera letra.
const INITIAL_SIM: f64 = 0.70;
/// Peso de los tokens sobrantes del lado con más tokens (es normal que una lista
/// tenga el segundo apellido o un segundo nombre que el cliente omitió).
const EXTRA_TOKEN_FACTOR: f64 = 0.35;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NameScore {
    pub score: f64,
    pub matched: usize,
    pub query_tokens: usize,
    pub candidate_tokens: usize,
    /// Promedio de Jaro-Winkler de los pares asignados (sin iniciales), para auditar.
    pub mean_similarity: f64,
}

/// Similitud de texto: promedio de Jaro-Winkler y Damerau-Levenshtein
/// normalizado (JW solo sobrevalora prefijos comunes: CASTILLO/CASTRO).
fn text_similarity(a: &str, b: &str) -> (f64, f64) {
    let jw = jaro_winkler(a, b);
    (0.5 * jw + 0.5 * normalized_damerau_levenshtein(a, b), jw)
}

/// Devuelve (similitud combinada, Jaro-Winkler) entre dos tokens.
pub fn token_similarity(a: &NameToken, b: &NameToken) -> (f64, f64) {
    if a.initial || b.initial {
        let s = if a.text.chars().next() == b.text.chars().next() {
            INITIAL_SIM
        } else {
            0.0
        };
        return (s, s);
    }
    if a.text == b.text {
        return (1.0, 1.0);
    }
    let (mut best, mut jw) = text_similarity(&a.text, &b.text);
    if a.compound.is_some() || b.compound.is_some() {
        let ac = a.compound.as_deref().unwrap_or(&a.text);
        let bc = b.compound.as_deref().unwrap_or(&b.text);
        for (x, y) in [(ac, b.text.as_str()), (a.text.as_str(), bc), (ac, bc)] {
            let (s, j) = text_similarity(x, y);
            if s > best {
                best = s;
                jw = j;
            }
        }
    }
    // Mismo sonido en español (VASQUEZ/BASQUEZ): casi igual.
    if a.key == b.key && a.key.len() >= 2 && best < 0.95 {
        best = 0.95;
    }
    (best, jw)
}

fn pair_weight(a: &NameToken, b: &NameToken) -> f64 {
    if a.initial || b.initial {
        1.5
    } else {
        (a.weight() + b.weight()) / 2.0
    }
}

pub fn name_similarity(q: &PreparedName, c: &PreparedName) -> NameScore {
    let (nq, nc) = (q.tokens.len(), c.tokens.len());
    let empty = NameScore {
        score: 0.0,
        matched: 0,
        query_tokens: nq,
        candidate_tokens: nc,
        mean_similarity: 0.0,
    };
    if nq == 0 || nc == 0 {
        return empty;
    }
    let mut pairs: Vec<(f64, f64, usize, usize)> = Vec::with_capacity(nq * nc);
    for (i, a) in q.tokens.iter().enumerate() {
        for (j, b) in c.tokens.iter().enumerate() {
            let (s, jw) = token_similarity(a, b);
            let is_initial = a.initial || b.initial;
            if (is_initial && s > 0.0) || s >= MIN_TOKEN_SIM {
                pairs.push((s, jw, i, j));
            }
        }
    }
    // Asignación voraz por similitud descendente; los tokens completos primero.
    pairs.sort_by(|x, y| y.0.total_cmp(&x.0).then(x.2.cmp(&y.2)).then(x.3.cmp(&y.3)));
    let mut used_q = vec![false; nq];
    let mut used_c = vec![false; nc];
    let (mut num, mut den, mut sim_sum, mut sim_n, mut matched) = (0.0, 0.0, 0.0, 0usize, 0usize);
    for (s, jw, i, j) in pairs {
        if used_q[i] || used_c[j] {
            continue;
        }
        used_q[i] = true;
        used_c[j] = true;
        let w = pair_weight(&q.tokens[i], &c.tokens[j]);
        num += s * w;
        den += w;
        matched += 1;
        if !(q.tokens[i].initial || c.tokens[j].initial) {
            sim_sum += jw;
            sim_n += 1;
        }
    }
    if matched == 0 {
        return empty;
    }
    let (fq, fc) = match nq.cmp(&nc) {
        std::cmp::Ordering::Less => (1.0, EXTRA_TOKEN_FACTOR),
        std::cmp::Ordering::Greater => (EXTRA_TOKEN_FACTOR, 1.0),
        std::cmp::Ordering::Equal => (1.0, 1.0),
    };
    let unmatched = |tokens: &[NameToken], used: &[bool], f: f64| -> f64 {
        tokens
            .iter()
            .zip(used)
            .filter(|(_, u)| !**u)
            .map(|(t, _)| t.weight() * f)
            .sum()
    };
    den += unmatched(&q.tokens, &used_q, fq) + unmatched(&c.tokens, &used_c, fc);
    NameScore {
        score: (num / den).clamp(0.0, 1.0),
        matched,
        query_tokens: nq,
        candidate_tokens: nc,
        mean_similarity: if sim_n > 0 { sim_sum / sim_n as f64 } else { INITIAL_SIM },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::prepare;

    fn sim(a: &str, b: &str) -> f64 {
        name_similarity(&prepare(a), &prepare(b)).score
    }

    #[test]
    fn identical_and_reordered() {
        assert!((sim("Juan Pérez García", "JUAN PEREZ GARCIA") - 1.0).abs() < 1e-9);
        assert!((sim("PEREZ GARCIA, Juan", "Juan Pérez García") - 1.0).abs() < 1e-9);
        assert!((sim("GARCIA JUAN PEREZ", "JUAN PEREZ GARCIA") - 1.0).abs() < 1e-9);
    }

    #[test]
    fn typos_and_phonetics() {
        assert!(sim("Juan Peres Garsia", "Juan Pérez García") > 0.9);
        assert!(sim("Wilber Basquez", "Wilber Vasquez") > 0.95);
        assert!(sim("Jhon Quispe", "John Quispe") > 0.9);
    }

    #[test]
    fn compound_surnames() {
        assert!(sim("Juan Delacruz", "Juan de la Cruz") > 0.95);
        assert!(sim("Juan de la Cruz", "JUAN DELACRUZ") > 0.95);
        // las partículas no puntúan
        assert!((sim("Juan Cruz", "Juan de la Cruz") - 1.0).abs() < 1e-9);
    }

    #[test]
    fn missing_second_surname_still_scores_high() {
        let s = sim("Juan Carlos Pérez", "Juan Carlos Pérez Gómez");
        assert!(s > 0.85 && s < 1.0, "{s}");
        let s = sim("Juan Carlos Pérez de la Cruz", "PEREZ DE LA CRUZ, Juan");
        assert!(s > 0.85, "{s}");
    }

    #[test]
    fn generic_partial_match_is_low() {
        assert!(sim("Juan Pérez", "Juan Carlos Pérez Gómez") < 0.75);
        assert!(sim("María Quispe", "Juan Pérez") < 0.3);
        assert!(sim("Pedro Castillo", "Pedro Castro") < 0.9);
    }

    #[test]
    fn initials() {
        let s = sim("J. Pérez García", "Juan Pérez García");
        assert!(s > 0.85 && s < 1.0, "{s}");
        assert!(sim("M. Pérez García", "Juan Pérez García") < 0.85);
    }

    #[test]
    fn empty_names() {
        assert_eq!(sim("", "Juan"), 0.0);
    }
}
