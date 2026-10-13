//! MRZ ICAO 9303 TD1 (3 líneas × 30 caracteres), usado por el DNI electrónico
//! peruano. Incluye validación de dígitos de control, resolución de siglo y
//! comparación con los campos impresos.

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::json;
use ukuk_core::{DocumentFields, Finding, Layer, Severity};

use crate::{dates, text};

const LINE_LEN: usize = 30;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MrzChecks {
    pub document_number: bool,
    pub birth_date: bool,
    pub expiry_date: bool,
    pub composite: bool,
}

/// Objeto `mrz` del contrato. Los campos son `null` cuando no se pudieron leer.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MrzData {
    pub valid: bool,
    pub document_type: Option<String>,
    pub issuing_state: Option<String>,
    pub document_number: Option<String>,
    pub birth_date: Option<String>,
    pub sex: Option<String>,
    pub expiry_date: Option<String>,
    pub nationality: Option<String>,
    pub surnames: Option<String>,
    pub given_names: Option<String>,
    pub checks: MrzChecks,
    /// DNI de 8 dígitos (del número de documento o, si no, de los datos opcionales).
    pub dni: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MrzAnalysis {
    pub mrz: MrzData,
    pub findings: Vec<Finding>,
}

/// Valor ICAO de un carácter: dígitos 0-9, A-Z = 10..35, '<' = 0.
pub fn char_value(c: u8) -> Option<u32> {
    match c {
        b'0'..=b'9' => Some(u32::from(c - b'0')),
        b'A'..=b'Z' => Some(u32::from(c - b'A') + 10),
        b'<' => Some(0),
        _ => None,
    }
}

/// Dígito de control ICAO 9303 (pesos 7, 3, 1).
pub fn check_digit(field: &str) -> Option<u32> {
    const WEIGHTS: [u32; 3] = [7, 3, 1];
    field
        .bytes()
        .enumerate()
        .try_fold(0u32, |acc, (i, c)| {
            Some(acc + char_value(c)? * WEIGHTS[i % 3])
        })
        .map(|s| s % 10)
}

fn verify(field: &str, check: u8) -> bool {
    let expected = match check {
        b'0'..=b'9' => u32::from(check - b'0'),
        b'<' => 0,
        _ => return false,
    };
    check_digit(field) == Some(expected)
}

/// Normaliza el texto recibido: mayúsculas, sin espacios, '«' → '<'; acepta una
/// sola línea de 90 caracteres. Rellena con '<' líneas cortas (el OCR suele
/// omitir los rellenos finales).
fn split_lines(input: &str) -> (Vec<String>, bool) {
    let mut lines: Vec<String> = input
        .lines()
        .map(|l| {
            l.chars()
                .filter(|c| !c.is_whitespace())
                .map(|c| {
                    if c == '«' {
                        '<'
                    } else {
                        c.to_ascii_uppercase()
                    }
                })
                .collect::<String>()
        })
        .filter(|l| !l.is_empty())
        .collect();
    if lines.len() == 1 && lines[0].len() == LINE_LEN * 3 && lines[0].is_ascii() {
        let l = lines.remove(0);
        lines = (0..3)
            .map(|i| l[i * LINE_LEN..(i + 1) * LINE_LEN].to_string())
            .collect();
    }
    let mut padded = false;
    for l in &mut lines {
        let n = l.chars().count();
        if (10..LINE_LEN).contains(&n) {
            l.extend(std::iter::repeat_n('<', LINE_LEN - n));
            padded = true;
        }
    }
    (lines, padded)
}

fn strip_filler(s: &str) -> String {
    s.trim_end_matches('<').replace('<', " ").trim().to_string()
}

fn names(field: &str) -> String {
    field
        .split('<')
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn yymmdd(s: &str) -> Option<(i32, u32, u32)> {
    if s.len() != 6 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((
        s[0..2].parse().ok()?,
        s[2..4].parse().ok()?,
        s[4..6].parse().ok()?,
    ))
}

/// Fecha de nacimiento: siempre en el pasado respecto de `today`.
pub fn resolve_birth(s: &str, today: NaiveDate) -> Option<NaiveDate> {
    let (yy, m, d) = yymmdd(s)?;
    let century = if 2000 + yy > today.year() { 1900 } else { 2000 };
    let date = NaiveDate::from_ymd_opt(century + yy, m, d)?;
    if date > today {
        NaiveDate::from_ymd_opt(1900 + yy, m, d)
    } else {
        Some(date)
    }
}

/// Fecha de vencimiento: ventana desde hace 50 años hasta dentro de 50.
pub fn resolve_expiry(s: &str, today: NaiveDate) -> Option<NaiveDate> {
    let (yy, m, d) = yymmdd(s)?;
    let year = if 2000 + yy > today.year() + 50 {
        1900 + yy
    } else {
        2000 + yy
    };
    NaiveDate::from_ymd_opt(year, m, d)
}

/// Busca un DNI (8 dígitos exactos) en un campo de datos opcionales.
fn dni_in(optional: &str) -> Option<String> {
    optional
        .split(|c: char| !c.is_ascii_digit())
        .find(|run| run.len() == 8)
        .map(str::to_string)
}

fn finding(code: &str, severity: Severity, confidence: f64, message: String) -> Finding {
    Finding::new(code, Layer::Consistency, severity, confidence, message)
}

/// Analiza una MRZ TD1.
pub fn parse_td1(input: &str, today: NaiveDate) -> MrzAnalysis {
    let mut findings = Vec::new();
    let mut mrz = MrzData::default();
    let (lines, padded) = split_lines(input);

    if lines.len() != 3 || lines.iter().any(|l| l.len() != LINE_LEN || !l.is_ascii()) {
        findings.push(
            finding(
                "mrz.invalid_format",
                Severity::High,
                0.9,
                "La MRZ no tiene el formato TD1 (3 líneas de 30 caracteres).".into(),
            )
            .with_evidence(json!({
                "lines": lines.len(),
                "lengths": lines.iter().map(|l| l.chars().count()).collect::<Vec<_>>(),
            })),
        );
        return MrzAnalysis { mrz, findings };
    }
    if padded {
        findings.push(finding(
            "mrz.padded",
            Severity::Info,
            0.5,
            "Se completaron con '<' líneas de la MRZ más cortas de lo normal (posible recorte del OCR).".into(),
        ));
    }

    let (l1, l2, l3) = (&lines[0], &lines[1], &lines[2]);
    let bad_chars: Vec<char> = lines
        .iter()
        .flat_map(|l| l.bytes())
        .filter(|b| char_value(*b).is_none())
        .map(char::from)
        .collect();
    if !bad_chars.is_empty() {
        findings.push(
            finding(
                "mrz.invalid_characters",
                Severity::Medium,
                0.8,
                "La MRZ contiene caracteres no permitidos (solo A-Z, 0-9 y '<').".into(),
            )
            .with_evidence(json!({ "characters": bad_chars.iter().collect::<String>() })),
        );
    }

    mrz.document_type = Some(strip_filler(&l1[0..2])).filter(|s| !s.is_empty());
    mrz.issuing_state = Some(strip_filler(&l1[2..5])).filter(|s| !s.is_empty());

    // Número de documento (con soporte del formato extendido > 9 caracteres).
    let doc_field = &l1[5..14];
    let doc_check = l1.as_bytes()[14];
    let optional1 = &l1[15..30];
    let (doc_number, doc_ok) = if doc_check == b'<' && !optional1.starts_with('<') {
        let ext = optional1.split('<').next().unwrap_or("");
        if ext.len() >= 2 {
            let (rest, cd) = ext.split_at(ext.len() - 1);
            let full = format!("{doc_field}{rest}");
            let ok = verify(&full, cd.as_bytes()[0]);
            (full.replace('<', ""), ok)
        } else {
            (strip_filler(doc_field), false)
        }
    } else {
        (strip_filler(doc_field), verify(doc_field, doc_check))
    };
    mrz.document_number = Some(doc_number.clone()).filter(|s| !s.is_empty());
    mrz.checks.document_number = doc_ok;

    let birth_raw = &l2[0..6];
    let expiry_raw = &l2[8..14];
    let optional2 = &l2[18..29];
    mrz.checks.birth_date = verify(birth_raw, l2.as_bytes()[6]);
    mrz.checks.expiry_date = verify(expiry_raw, l2.as_bytes()[14]);
    let composite = format!("{}{}{}{}", &l1[5..30], &l2[0..7], &l2[8..15], optional2);
    mrz.checks.composite = verify(&composite, l2.as_bytes()[29]);

    mrz.sex = Some(match &l2[7..8] {
        "M" => "M".to_string(),
        "F" => "F".to_string(),
        _ => "X".to_string(),
    });
    mrz.nationality = Some(strip_filler(&l2[15..18])).filter(|s| !s.is_empty());

    let birth = resolve_birth(birth_raw, today);
    let no_expiry = expiry_raw.bytes().all(|b| b == b'<');
    let expiry = if no_expiry {
        None
    } else {
        resolve_expiry(expiry_raw, today)
    };
    mrz.birth_date = birth.map(|d| d.to_string());
    mrz.expiry_date = expiry.map(|d| d.to_string());
    let mut dates_ok = true;
    if birth.is_none() {
        dates_ok = false;
        findings.push(
            finding(
                "mrz.invalid_date",
                Severity::High,
                0.9,
                format!("La fecha de nacimiento de la MRZ («{birth_raw}») no es válida."),
            )
            .with_evidence(json!({ "field": "birth_date", "value": birth_raw })),
        );
    }
    if expiry.is_none() && !no_expiry {
        dates_ok = false;
        findings.push(
            finding(
                "mrz.invalid_date",
                Severity::High,
                0.9,
                format!("La fecha de vencimiento de la MRZ («{expiry_raw}») no es válida."),
            )
            .with_evidence(json!({ "field": "expiry_date", "value": expiry_raw })),
        );
    }
    if let Some(e) = expiry.filter(|e| *e < today) {
        findings.push(
            finding(
                "mrz.expired",
                Severity::Medium,
                0.9,
                format!("Según la MRZ, el documento venció el {e}."),
            )
            .with_evidence(json!({ "expiry_date": e.to_string(), "today": today.to_string() })),
        );
    }

    let (surnames, given) = match l3.split_once("<<") {
        Some((s, g)) => (names(s), names(g)),
        None => (names(l3), String::new()),
    };
    mrz.surnames = Some(surnames).filter(|s| !s.is_empty());
    mrz.given_names = Some(given).filter(|s| !s.is_empty());

    let is_dni = |s: &str| s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit());
    mrz.dni = if is_dni(&doc_number) {
        Some(doc_number.clone())
    } else {
        dni_in(optional1).or_else(|| dni_in(optional2))
    };

    let check_specs = [
        (
            "document_number",
            mrz.checks.document_number,
            "número de documento",
        ),
        ("birth_date", mrz.checks.birth_date, "fecha de nacimiento"),
        (
            "expiry_date",
            mrz.checks.expiry_date,
            "fecha de vencimiento",
        ),
        ("composite", mrz.checks.composite, "dígito compuesto"),
    ];
    for (name, ok, label) in check_specs {
        if !ok {
            findings.push(
                finding(
                    &format!("mrz.check_digit_{name}"),
                    Severity::High,
                    0.9,
                    format!("El dígito de control de la MRZ ({label}) no coincide."),
                )
                .with_evidence(json!({ "check": name })),
            );
        }
    }

    mrz.valid = bad_chars.is_empty()
        && dates_ok
        && mrz.checks.document_number
        && mrz.checks.birth_date
        && mrz.checks.expiry_date
        && mrz.checks.composite;
    MrzAnalysis { mrz, findings }
}

/// Compara letra a letra ignorando espacios; si la línea 3 de la MRZ está llena,
/// el nombre pudo truncarse y se acepta como prefijo.
fn names_match(printed: &str, mrz: &str, mrz_truncated: bool) -> bool {
    let p = text::fold_compact(printed);
    // Transliteración ICAO alternativa de Ñ.
    let m = text::fold_compact(mrz).replace("NXX", "N");
    if p == m {
        return true;
    }
    mrz_truncated && !m.is_empty() && p.starts_with(&m)
}

/// El DNIe peruano lleva en la MRZ solo el primer apellido (PEREZ frente a
/// PEREZ GARCIA impreso): se acepta si la MRZ coincide con los primeros apellidos
/// completos, nunca con medio apellido.
fn surnames_match(printed: &str, mrz: &str, mrz_truncated: bool) -> bool {
    if names_match(printed, mrz, mrz_truncated) {
        return true;
    }
    let m = text::fold_compact(mrz).replace("NXX", "N");
    let mut prefix = String::new();
    text::fold(printed).split(' ').any(|token| {
        prefix.push_str(token);
        prefix == m
    })
}

fn sex_code(s: &str) -> Option<char> {
    match text::fold(s).chars().next()? {
        'M' | 'H' => Some('M'),
        'F' => Some('F'),
        _ => None,
    }
}

/// Compara la MRZ con los campos impresos y devuelve hallazgos `mrz.*_mismatch`.
pub fn cross_check(mrz: &MrzData, fields: &DocumentFields, mrz_raw: Option<&str>) -> Vec<Finding> {
    let mut out = Vec::new();
    let mismatch = |code: &str, label: &str, printed: &str, in_mrz: &str, severity: Severity| {
        Finding::new(
            code,
            Layer::Consistency,
            severity,
            0.9,
            format!("El {label} impreso («{printed}») no coincide con la MRZ («{in_mrz}»)."),
        )
        .with_evidence(json!({ "printed": printed, "mrz": in_mrz }))
    };
    let truncated = mrz_raw
        .and_then(|raw| split_lines(raw).0.get(2).cloned())
        .is_some_and(|l3| l3.len() == LINE_LEN && !l3.ends_with('<'));

    if let (Some(p), Some(m)) = (
        fields.dni.as_deref().map(|d| crate::dni::split(d).0),
        mrz.dni.as_deref().or(mrz.document_number.as_deref()),
    ) && !p.is_empty()
        && p != m
    {
        out.push(mismatch("mrz.dni_mismatch", "DNI", p, m, Severity::High));
    }
    if let (Some(p), Some(m)) = (fields.apellidos.as_deref(), mrz.surnames.as_deref())
        && !p.trim().is_empty()
        && !surnames_match(p, m, truncated)
    {
        out.push(mismatch(
            "mrz.surname_mismatch",
            "apellido",
            p.trim(),
            m,
            Severity::High,
        ));
    }
    if let (Some(p), Some(m)) = (fields.nombres.as_deref(), mrz.given_names.as_deref())
        && !p.trim().is_empty()
        && !names_match(p, m, truncated)
    {
        out.push(mismatch(
            "mrz.given_names_mismatch",
            "nombre",
            p.trim(),
            m,
            Severity::High,
        ));
    }
    if let (Some(p), Some(m)) = (
        fields.fecha_nacimiento.as_deref(),
        mrz.birth_date.as_deref(),
    ) && let Some(pd) = dates::parse_valid(p)
        && pd.to_string() != m
    {
        out.push(mismatch(
            "mrz.birth_date_mismatch",
            "fecha de nacimiento",
            &pd.to_string(),
            m,
            Severity::High,
        ));
    }
    if let (Some(p), Some(m)) = (
        fields.fecha_vencimiento.as_deref(),
        mrz.expiry_date.as_deref(),
    ) && let Some(pd) = dates::parse_valid(p)
        && pd.to_string() != m
    {
        out.push(mismatch(
            "mrz.expiry_date_mismatch",
            "fecha de vencimiento",
            &pd.to_string(),
            m,
            Severity::High,
        ));
    }
    if let (Some(p), Some(m)) = (fields.sexo.as_deref(), mrz.sex.as_deref())
        && let Some(pc) = sex_code(p)
        && m != "X"
        && !m.starts_with(pc)
    {
        out.push(mismatch(
            "mrz.sex_mismatch",
            "sexo",
            p.trim(),
            m,
            Severity::Medium,
        ));
    }
    out
}

/// Utilidades para construir MRZ válidas en pruebas (también útiles en otros crates).
pub mod testing {
    use super::check_digit;

    fn pad(s: &str, n: usize) -> String {
        let mut s = s.to_string();
        while s.len() < n {
            s.push('<');
        }
        s
    }

    /// Construye una MRZ TD1 con dígitos de control correctos.
    pub fn build_td1(
        doc_number: &str,
        birth: &str,
        sex: char,
        expiry: &str,
        surnames: &str,
        given: &str,
        optional1: &str,
    ) -> String {
        let doc = pad(doc_number, 9);
        let l1 = format!(
            "I<PER{doc}{}{}",
            check_digit(&doc).unwrap(),
            pad(optional1, 15)
        );
        let opt2 = pad("", 11);
        let head = format!(
            "{birth}{}{sex}{expiry}{}PER",
            check_digit(birth).unwrap(),
            check_digit(expiry).unwrap()
        );
        let composite = format!("{}{}{}{}", &l1[5..30], &head[0..7], &head[8..15], opt2);
        let l2 = format!("{head}{opt2}{}", check_digit(&composite).unwrap());
        let name = format!(
            "{}<<{}",
            surnames.replace(' ', "<"),
            given.replace(' ', "<")
        );
        let l3: String = pad(&name, 30).chars().take(30).collect();
        format!("{l1}\n{l2}\n{l3}")
    }
}

#[cfg(test)]
mod tests {
    use super::testing::build_td1;
    use super::*;

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 13).unwrap()
    }

    fn sample() -> String {
        build_td1(
            "12345678",
            "900531",
            'M',
            "300101",
            "PEREZ GARCIA",
            "JUAN CARLOS",
            "",
        )
    }

    fn codes(f: &[Finding]) -> Vec<&str> {
        f.iter().map(|f| f.code.as_str()).collect()
    }

    #[test]
    fn icao_reference_check_digits() {
        // Ejemplos del documento ICAO 9303 parte 5.
        assert_eq!(check_digit("D23145890"), Some(7));
        assert_eq!(check_digit("740812"), Some(2));
        assert_eq!(check_digit("120415"), Some(9));
        assert_eq!(check_digit("L898902C<"), Some(3));
        assert_eq!(check_digit("a"), None);
    }

    #[test]
    fn icao_td1_specimen() {
        let mrz = "I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<";
        let a = parse_td1(mrz, NaiveDate::from_ymd_opt(2010, 1, 1).unwrap());
        assert!(a.mrz.valid, "{:?}", a.findings);
        assert_eq!(a.mrz.document_number.as_deref(), Some("D23145890"));
        assert_eq!(a.mrz.birth_date.as_deref(), Some("1974-08-12"));
        assert_eq!(a.mrz.expiry_date.as_deref(), Some("2012-04-15"));
        assert_eq!(a.mrz.sex.as_deref(), Some("F"));
        assert_eq!(a.mrz.surnames.as_deref(), Some("ERIKSSON"));
        assert_eq!(a.mrz.given_names.as_deref(), Some("ANNA MARIA"));
        assert_eq!(a.mrz.issuing_state.as_deref(), Some("UTO"));
        assert_eq!(a.mrz.dni, None);
    }

    #[test]
    fn peruvian_dni_valid() {
        let a = parse_td1(&sample(), today());
        assert!(a.mrz.valid, "{:?}", a.findings);
        assert!(a.findings.is_empty());
        let m = &a.mrz;
        assert_eq!(m.document_type.as_deref(), Some("I"));
        assert_eq!(m.issuing_state.as_deref(), Some("PER"));
        assert_eq!(m.document_number.as_deref(), Some("12345678"));
        assert_eq!(m.dni.as_deref(), Some("12345678"));
        assert_eq!(m.birth_date.as_deref(), Some("1990-05-31"));
        assert_eq!(m.expiry_date.as_deref(), Some("2030-01-01"));
        assert_eq!(m.nationality.as_deref(), Some("PER"));
        assert_eq!(m.surnames.as_deref(), Some("PEREZ GARCIA"));
        assert_eq!(m.given_names.as_deref(), Some("JUAN CARLOS"));
        assert!(m.checks.composite);
    }

    #[test]
    fn dni_in_optional_data() {
        let mrz = build_td1(
            "A1B2C3D4E",
            "900531",
            'F',
            "300101",
            "QUISPE",
            "ROSA",
            "<87654321<",
        );
        let a = parse_td1(&mrz, today());
        assert!(a.mrz.valid);
        assert_eq!(a.mrz.document_number.as_deref(), Some("A1B2C3D4E"));
        assert_eq!(a.mrz.dni.as_deref(), Some("87654321"));
    }

    #[test]
    fn tampered_digits_are_detected() {
        let good = sample();
        // Cambiar un dígito del DNI rompe su control y el compuesto.
        let bad = good.replacen("12345678", "12345679", 1);
        let a = parse_td1(&bad, today());
        assert!(!a.mrz.valid);
        assert!(!a.mrz.checks.document_number);
        assert!(!a.mrz.checks.composite);
        assert!(codes(&a.findings).contains(&"mrz.check_digit_document_number"));
        assert!(codes(&a.findings).contains(&"mrz.check_digit_composite"));
        // Cambiar la fecha de nacimiento.
        let bad = good.replacen("900531", "910531", 1);
        let a = parse_td1(&bad, today());
        assert!(!a.mrz.checks.birth_date);
        assert!(a.mrz.checks.document_number);
    }

    #[test]
    fn century_resolution() {
        assert_eq!(resolve_birth("251231", today()).unwrap().year(), 2025);
        assert_eq!(resolve_birth("271231", today()).unwrap().year(), 1927);
        assert_eq!(resolve_birth("260101", today()).unwrap().year(), 2026);
        assert_eq!(resolve_birth("261231", today()).unwrap().year(), 1926);
        assert_eq!(resolve_birth("050101", today()).unwrap().year(), 2005);
        assert_eq!(resolve_expiry("300101", today()).unwrap().year(), 2030);
        assert_eq!(resolve_expiry("990101", today()).unwrap().year(), 1999);
        assert_eq!(resolve_expiry("760101", today()).unwrap().year(), 2076);
        assert!(resolve_birth("901332", today()).is_none());
    }

    #[test]
    fn expired_and_invalid_dates() {
        let mrz = build_td1("12345678", "900531", 'M', "200101", "PEREZ", "JUAN", "");
        let a = parse_td1(&mrz, today());
        assert!(a.mrz.valid);
        assert_eq!(codes(&a.findings), vec!["mrz.expired"]);
        let mrz = build_td1("12345678", "901331", 'M', "300101", "PEREZ", "JUAN", "");
        let a = parse_td1(&mrz, today());
        assert!(!a.mrz.valid);
        assert!(codes(&a.findings).contains(&"mrz.invalid_date"));
    }

    #[test]
    fn invalid_format_and_characters() {
        let a = parse_td1("I<PER123\nfoo", today());
        assert!(!a.mrz.valid);
        assert_eq!(codes(&a.findings), vec!["mrz.invalid_format"]);
        let bad = sample().replacen("PEREZ", "PER#Z", 1);
        let a = parse_td1(&bad, today());
        assert!(codes(&a.findings).contains(&"mrz.invalid_characters"));
        assert!(!a.mrz.valid);
    }

    #[test]
    fn tolerant_input() {
        // Minúsculas, espacios, CRLF y rellenos finales recortados.
        let s = sample();
        let messy: String = s
            .lines()
            .map(|l| l.trim_end_matches('<').to_lowercase())
            .collect::<Vec<_>>()
            .join(" \r\n");
        let a = parse_td1(&messy, today());
        assert!(a.mrz.valid, "{:?}", a.findings);
        assert_eq!(codes(&a.findings), vec!["mrz.padded"]);
        // Una sola línea de 90 caracteres.
        let one: String = s.lines().collect();
        assert!(parse_td1(&one, today()).mrz.valid);
    }

    #[test]
    fn long_document_number() {
        // Número de 12 caracteres: 9 en el campo, resto + control en datos opcionales.
        let full = "ABC123456789";
        let cd = check_digit(full).unwrap();
        let l1 = format!("I<PER{}<{}{}", &full[..9], &full[9..], cd);
        let l1 = format!("{l1:<<30}");
        let head = format!(
            "900531{}M300101{}PER",
            check_digit("900531").unwrap(),
            check_digit("300101").unwrap()
        );
        let opt2 = "<".repeat(11);
        let comp = format!("{}{}{}{}", &l1[5..30], &head[0..7], &head[8..15], opt2);
        let l2 = format!("{head}{opt2}{}", check_digit(&comp).unwrap());
        let l3 = format!("{:<<30}", "PEREZ<<JUAN");
        let a = parse_td1(&format!("{l1}\n{l2}\n{l3}"), today());
        assert!(a.mrz.valid, "{:?}", a.findings);
        assert_eq!(a.mrz.document_number.as_deref(), Some(full));
    }

    #[test]
    fn cross_check_matches_accent_insensitive() {
        let raw = build_td1(
            "12345678",
            "900531",
            'M',
            "300101",
            "MUNOZ DE LA CRUZ",
            "JOSE",
            "",
        );
        let a = parse_td1(&raw, today());
        let fields = DocumentFields {
            dni: Some("12345678".into()),
            apellidos: Some("Muñoz de la Cruz".into()),
            nombres: Some("José".into()),
            fecha_nacimiento: Some("31/05/1990".into()),
            fecha_vencimiento: Some("2030-01-01".into()),
            sexo: Some("Masculino".into()),
            ..Default::default()
        };
        assert!(cross_check(&a.mrz, &fields, Some(&raw)).is_empty());
    }

    /// La MRZ del DNI peruano (DNIe y DNI azul) lleva solo el primer apellido; se vio en
    /// dos DNI reales. Por privacidad la prueba usa datos inventados.
    #[test]
    fn dni_mrz_carries_only_first_surname() {
        let raw = build_td1(
            "12345678",
            "001223",
            'M',
            "360106",
            "PEREZ",
            "JUAN CARLOS",
            "",
        );
        let a = parse_td1(&raw, today());
        assert!(a.findings.is_empty(), "{:?}", a.findings);
        let fields = DocumentFields {
            dni: Some("12345678-1".into()),
            apellidos: Some("PEREZ GARCIA".into()),
            nombres: Some("JUAN CARLOS".into()),
            fecha_nacimiento: Some("2000-12-23".into()),
            fecha_vencimiento: Some("2036-01-06".into()),
            sexo: Some("M".into()),
            ..Default::default()
        };
        assert!(cross_check(&a.mrz, &fields, Some(&raw)).is_empty());
        // Otro primer apellido sí es discrepancia, y medio apellido no basta.
        for other in ["QUISPE GARCIA", "PERE GARCIA"] {
            let f = DocumentFields {
                apellidos: Some(other.into()),
                ..fields.clone()
            };
            let codes: Vec<_> = cross_check(&a.mrz, &f, Some(&raw))
                .into_iter()
                .map(|f| f.code)
                .collect();
            assert_eq!(codes, vec!["mrz.surname_mismatch"], "{other}");
        }
    }

    #[test]
    fn cross_check_reports_mismatches() {
        let raw = sample();
        let a = parse_td1(&raw, today());
        let fields = DocumentFields {
            dni: Some("87654321".into()),
            apellidos: Some("PÉREZ GARCÍA".into()),
            nombres: Some("JUAN CARLOS ALBERTO".into()),
            fecha_nacimiento: Some("1990-05-30".into()),
            fecha_vencimiento: Some("2031-01-01".into()),
            sexo: Some("F".into()),
            ..Default::default()
        };
        let f = cross_check(&a.mrz, &fields, Some(&raw));
        assert_eq!(
            codes(&f),
            vec![
                "mrz.dni_mismatch",
                "mrz.given_names_mismatch",
                "mrz.birth_date_mismatch",
                "mrz.expiry_date_mismatch",
                "mrz.sex_mismatch"
            ]
        );
    }

    #[test]
    fn truncated_names_are_accepted_as_prefix() {
        let raw = build_td1(
            "12345678",
            "900531",
            'M',
            "300101",
            "VILLANUEVA SANTISTEBAN",
            "MAXIMILIANO",
            "",
        );
        let a = parse_td1(&raw, today());
        assert_eq!(a.mrz.given_names.as_deref(), Some("MAXIMI"));
        let fields = DocumentFields {
            nombres: Some("Maximiliano".into()),
            ..Default::default()
        };
        assert!(cross_check(&a.mrz, &fields, Some(&raw)).is_empty());
    }
}
