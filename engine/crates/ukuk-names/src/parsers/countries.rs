//! Mapa reducido de nombres de país (inglés/español) a ISO 3166-1 alfa-2.

use crate::normalize::normalize;

const COUNTRIES: &[(&str, &[&str])] = &[
    ("PE", &["PERU"]),
    ("CO", &["COLOMBIA"]),
    ("MX", &["MEXICO"]),
    ("VE", &["VENEZUELA"]),
    ("EC", &["ECUADOR"]),
    ("BO", &["BOLIVIA"]),
    ("CL", &["CHILE"]),
    ("AR", &["ARGENTINA"]),
    ("BR", &["BRAZIL", "BRASIL"]),
    ("PY", &["PARAGUAY"]),
    ("UY", &["URUGUAY"]),
    ("PA", &["PANAMA"]),
    ("CR", &["COSTA RICA"]),
    ("NI", &["NICARAGUA"]),
    ("HN", &["HONDURAS"]),
    ("SV", &["EL SALVADOR"]),
    ("GT", &["GUATEMALA"]),
    ("CU", &["CUBA"]),
    ("DO", &["DOMINICAN REPUBLIC", "REPUBLICA DOMINICANA"]),
    ("HT", &["HAITI"]),
    ("US", &["UNITED STATES", "ESTADOS UNIDOS", "USA"]),
    ("CA", &["CANADA"]),
    ("ES", &["SPAIN", "ESPANA"]),
    ("PT", &["PORTUGAL"]),
    ("FR", &["FRANCE", "FRANCIA"]),
    ("IT", &["ITALY", "ITALIA"]),
    ("DE", &["GERMANY", "ALEMANIA"]),
    ("GB", &["UNITED KINGDOM", "REINO UNIDO"]),
    ("RU", &["RUSSIA", "RUSSIAN FEDERATION", "RUSIA"]),
    ("CN", &["CHINA"]),
    (
        "KP",
        &[
            "NORTH KOREA",
            "KOREA NORTH",
            "DEMOCRATIC PEOPLE S REPUBLIC OF KOREA",
        ],
    ),
    ("IR", &["IRAN", "IRAN ISLAMIC REPUBLIC OF"]),
    ("IQ", &["IRAQ"]),
    ("SY", &["SYRIA", "SYRIAN ARAB REPUBLIC"]),
    ("AF", &["AFGHANISTAN"]),
    ("PK", &["PAKISTAN"]),
    ("LB", &["LEBANON"]),
    ("YE", &["YEMEN"]),
    ("SO", &["SOMALIA"]),
    ("LY", &["LIBYA"]),
    ("SD", &["SUDAN"]),
    ("SA", &["SAUDI ARABIA"]),
    ("TR", &["TURKEY", "TURKIYE"]),
    ("IN", &["INDIA"]),
    ("PH", &["PHILIPPINES"]),
    ("NG", &["NIGERIA"]),
];

/// Devuelve el código ISO2 si se reconoce el país; si ya es un código de 2 letras lo conserva.
pub fn country_code(name: &str) -> Option<&'static str> {
    let n = normalize(name);
    COUNTRIES
        .iter()
        .find(|(code, names)| *code == n || names.contains(&n.as_str()))
        .map(|(code, _)| *code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_names() {
        assert_eq!(country_code("Peru"), Some("PE"));
        assert_eq!(country_code("Perú"), Some("PE"));
        assert_eq!(country_code("pe"), Some("PE"));
        assert_eq!(country_code("Iran (Islamic Republic of)"), Some("IR"));
        assert_eq!(country_code("Atlantis"), None);
    }
}
