//! RUC (Registro Único de Contribuyentes): 11 dígitos, prefijo y dígito verificador
//! módulo 11 con pesos 5,4,3,2,7,6,5,4,3,2.

use serde::{Deserialize, Serialize};
use serde_json::json;
use ukuk_core::{Finding, Layer, Severity};

const WEIGHTS: [u32; 10] = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RucKind {
    PersonaNatural,
    PersonaJuridica,
    NoDomiciliado,
    Desconocido,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RucValidation {
    pub valid: bool,
    pub kind: RucKind,
}

/// Motivo por el que un RUC no es válido.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RucError {
    Format,
    Prefix,
    CheckDigit { expected: u32, found: u32 },
}

pub fn kind_of(ruc: &str) -> RucKind {
    match ruc.get(..2) {
        Some("10") => RucKind::PersonaNatural,
        Some("20") => RucKind::PersonaJuridica,
        Some("15" | "16" | "17") => RucKind::NoDomiciliado,
        _ => RucKind::Desconocido,
    }
}

/// Dígito verificador para los primeros 10 dígitos.
pub fn check_digit(first10: &[u32]) -> u32 {
    let sum: u32 = first10.iter().zip(WEIGHTS).map(|(d, w)| d * w).sum();
    match 11 - sum % 11 {
        10 => 0,
        11 => 1,
        r => r,
    }
}

pub fn check(ruc: &str) -> Result<(), RucError> {
    let ruc = ruc.trim();
    if ruc.len() != 11 || !ruc.bytes().all(|b| b.is_ascii_digit()) {
        return Err(RucError::Format);
    }
    if kind_of(ruc) == RucKind::Desconocido {
        return Err(RucError::Prefix);
    }
    let digits: Vec<u32> = ruc.bytes().map(|b| u32::from(b - b'0')).collect();
    let expected = check_digit(&digits[..10]);
    if expected != digits[10] {
        return Err(RucError::CheckDigit {
            expected,
            found: digits[10],
        });
    }
    Ok(())
}

pub fn validate(ruc: &str) -> RucValidation {
    let ruc = ruc.trim();
    RucValidation {
        valid: check(ruc).is_ok(),
        kind: kind_of(ruc),
    }
}

pub fn findings(ruc: &str) -> Vec<Finding> {
    let ruc = ruc.trim();
    let (reason, message) = match check(ruc) {
        Ok(()) => return Vec::new(),
        Err(RucError::Format) => (
            "format".to_string(),
            format!("El RUC «{ruc}» no tiene 11 dígitos numéricos."),
        ),
        Err(RucError::Prefix) => (
            "prefix".to_string(),
            format!("El RUC «{ruc}» tiene un prefijo no válido (se esperaba 10, 15, 16, 17 o 20)."),
        ),
        Err(RucError::CheckDigit { expected, found }) => (
            "check_digit".to_string(),
            format!(
                "El dígito verificador del RUC «{ruc}» no es válido (esperado {expected}, impreso {found})."
            ),
        ),
    };
    vec![
        Finding::new("ruc.invalid", Layer::Consistency, Severity::High, 0.95, message)
            .with_evidence(json!({ "ruc": ruc, "reason": reason })),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_valid_rucs() {
        for r in ["20100047218", "20131312955", "20100070970", "10467793549"] {
            assert!(validate(r).valid, "{r}");
        }
        assert_eq!(validate("20100047218").kind, RucKind::PersonaJuridica);
        assert_eq!(validate("10467793549").kind, RucKind::PersonaNatural);
    }

    #[test]
    fn invalid_check_digit() {
        assert_eq!(
            check("20100047219"),
            Err(RucError::CheckDigit {
                expected: 8,
                found: 9
            })
        );
        assert!(!validate("20100047219").valid);
    }

    #[test]
    fn invalid_format_and_prefix() {
        assert_eq!(check("2010004721"), Err(RucError::Format));
        assert_eq!(check("2010004721A"), Err(RucError::Format));
        assert_eq!(check("30100047218"), Err(RucError::Prefix));
        assert_eq!(validate("30100047218").kind, RucKind::Desconocido);
    }

    #[test]
    fn no_domiciliado_prefixes() {
        for p in ["15", "16", "17"] {
            let mut digits: Vec<u32> = format!("{p}12345678")
                .bytes()
                .map(|b| u32::from(b - b'0'))
                .collect();
            let cd = check_digit(&digits);
            digits.push(cd);
            let s: String = digits.iter().map(|d| char::from(b'0' + *d as u8)).collect();
            let v = validate(&s);
            assert!(v.valid, "{s}");
            assert_eq!(v.kind, RucKind::NoDomiciliado);
        }
    }

    #[test]
    fn remainder_mapping() {
        // suma % 11 == 0 → r = 11 → 1
        assert_eq!(check_digit(&[0; 10]), 1);
        // suma = 12 → r = 10 → 0
        assert_eq!(check_digit(&[0, 0, 0, 6, 0, 0, 0, 0, 0, 0]), 0);
    }

    #[test]
    fn findings_messages() {
        assert!(findings("20100047218").is_empty());
        let f = findings("20100047219");
        assert_eq!(f[0].code, "ruc.invalid");
        assert_eq!(f[0].evidence.as_ref().unwrap()["reason"], "check_digit");
    }

    #[test]
    fn kind_serialization() {
        let v = serde_json::to_value(validate("20100047218")).unwrap();
        assert_eq!(v, serde_json::json!({"valid": true, "kind": "persona_juridica"}));
    }
}
