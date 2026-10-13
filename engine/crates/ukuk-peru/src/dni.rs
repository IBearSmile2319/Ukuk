//! DNI peruano: 8 dígitos.

use serde_json::json;
use ukuk_core::{Finding, Layer, Severity};

pub fn is_valid_format(dni: &str) -> bool {
    let dni = dni.trim();
    dni.len() == 8 && dni.bytes().all(|b| b.is_ascii_digit())
}

pub fn findings(dni: &str) -> Vec<Finding> {
    if is_valid_format(dni) {
        return Vec::new();
    }
    vec![
        Finding::new(
            "dni.invalid_format",
            Layer::Consistency,
            Severity::High,
            0.95,
            format!("El DNI «{}» no tiene el formato de 8 dígitos.", dni.trim()),
        )
        .with_evidence(json!({ "dni": dni.trim() })),
    ]
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
}
