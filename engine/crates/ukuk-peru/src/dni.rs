//! DNI peruano: 8 dígitos y, en el DNIe, un dígito de verificación tras el guion
//! del CUI (12345678-1).

use serde_json::json;
use ukuk_core::{Finding, Layer, Severity};

pub fn is_valid_format(dni: &str) -> bool {
    let dni = dni.trim();
    dni.len() == 8 && dni.bytes().all(|b| b.is_ascii_digit())
}

/// Separa el número del dígito de verificación: "12345678-1" → ("12345678", Some('1')).
pub fn split(dni: &str) -> (&str, Option<char>) {
    let dni = dni.trim();
    match dni.split_once('-') {
        Some((n, d)) if d.chars().count() == 1 => (n.trim(), d.chars().next()),
        _ => (dni, None),
    }
}

/// Dígito de verificación del DNI: número o letra equivalente (las dos series que usa
/// RENIEC). Algoritmo de uso público (pesos 3,2,7,6,5,4,3,2); se comprobó con dos DNI
/// reales (un DNIe 3.0 y un DNI azul); falta validarlo con más muestras en el piloto.
pub fn check_digit(number: &str) -> Option<(char, char)> {
    if !is_valid_format(number) {
        return None;
    }
    const WEIGHTS: [u32; 8] = [3, 2, 7, 6, 5, 4, 3, 2];
    const DIGITS: [char; 11] = ['6', '7', '8', '9', '0', '1', '1', '2', '3', '4', '5'];
    const LETTERS: [char; 11] = ['K', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    let sum: u32 = number
        .trim()
        .bytes()
        .zip(WEIGHTS)
        .map(|(b, w)| u32::from(b - b'0') * w)
        .sum();
    let i = (11 - sum % 11) as usize % 11;
    Some((DIGITS[i], LETTERS[i]))
}

pub fn findings(dni: &str) -> Vec<Finding> {
    let (number, given) = split(dni);
    if !is_valid_format(number) {
        return vec![
            Finding::new(
                "dni.invalid_format",
                Layer::Consistency,
                Severity::High,
                0.95,
                format!("El DNI «{}» no tiene el formato de 8 dígitos.", dni.trim()),
            )
            .with_evidence(json!({ "dni": dni.trim() })),
        ];
    }
    match (given.map(|c| c.to_ascii_uppercase()), check_digit(number)) {
        (Some(g), Some((d, l))) if g != d && g != l => vec![
            Finding::new(
                "dni.check_digit_mismatch",
                Layer::Consistency,
                Severity::High,
                0.9,
                format!(
                    "El dígito de verificación «{g}» no corresponde al DNI {number} (debería ser «{d}»): el número pudo ser alterado."
                ),
            )
            .with_evidence(json!({ "dni": number, "printed": g.to_string(), "expected": [d.to_string(), l.to_string()] })),
        ],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dni_format() {
        assert!(is_valid_format("12345678"));
        assert!(is_valid_format(" 01234567 "));
        assert!(!is_valid_format("1234567"));
        assert!(!is_valid_format("123456789"));
        assert!(!is_valid_format("1234567A"));
        assert_eq!(findings("123").len(), 1);
        assert!(findings("12345678").is_empty());
    }

    // Por privacidad, las pruebas usan números inventados, no los DNI reales con que
    // se comprobó el algoritmo.
    #[test]
    fn check_digit_number_or_letter() {
        assert_eq!(check_digit("12345678"), Some(('1', 'E')));
        assert!(findings("12345678-1").is_empty());
        assert!(findings("12345678-e").is_empty());
        assert_eq!(split("12345678-1"), ("12345678", Some('1')));
    }

    #[test]
    fn altered_number_breaks_check_digit() {
        let f = findings("12345679-1");
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].code, "dni.check_digit_mismatch");
        assert_eq!(f[0].severity, Severity::High);
        assert_eq!(findings("1234567-1")[0].code, "dni.invalid_format");
    }
}
