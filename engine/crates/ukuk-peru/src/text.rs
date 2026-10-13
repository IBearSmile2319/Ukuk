//! Normalización de texto insensible a tildes, para comparar campos impresos.

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

/// Mayúsculas, sin tildes (Ñ→N), signos convertidos en espacio, espacios colapsados.
pub fn fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for c in s.nfd().filter(|c| !is_combining_mark(*c)) {
        if c.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.extend(c.to_uppercase());
        } else if c == '\'' || c == '’' {
            // O'BRIEN → OBRIEN
        } else {
            pending_space = true;
        }
    }
    out
}

/// Igual que [`fold`] pero sin espacios: útil para comparar con la MRZ.
pub fn fold_compact(s: &str) -> String {
    fold(s).chars().filter(|c| !c.is_whitespace()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_accents_and_punctuation() {
        assert_eq!(fold("  Muñoz-Pérez,  José  "), "MUNOZ PEREZ JOSE");
        assert_eq!(fold("O'Brien"), "OBRIEN");
        assert_eq!(fold_compact("De la Cruz"), "DELACRUZ");
    }
}
