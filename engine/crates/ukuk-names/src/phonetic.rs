//! Clave fonética española simplificada, usada para el bloqueo del índice.
//!
//! Reglas: B/V/W→B, Z y C(e,i)→S, C(a,o,u)/QU/K→K, CH→X, LL/Y(+vocal)→Y,
//! H muda, G(e,i)/J→J, GU(e,i)→G, PH→F, X→KS, letras dobles colapsadas.

fn is_vowel(c: u8) -> bool {
    matches!(c, b'A' | b'E' | b'I' | b'O' | b'U')
}

pub fn key(token: &str) -> String {
    let b = token.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();
        let next2 = b.get(i + 2).copied();
        match c {
            b'Q' => {
                out.push(b'K');
                if next == Some(b'U') {
                    i += 1;
                }
            }
            b'C' => match next {
                Some(b'H') => {
                    out.push(b'X');
                    i += 1;
                }
                Some(b'E' | b'I') => out.push(b'S'),
                _ => out.push(b'K'),
            },
            b'G' => match next {
                Some(b'E' | b'I') => out.push(b'J'),
                Some(b'U') if matches!(next2, Some(b'E' | b'I')) => {
                    out.push(b'G');
                    i += 1;
                }
                _ => out.push(b'G'),
            },
            b'L' if next == Some(b'L') => {
                out.push(b'Y');
                i += 1;
            }
            b'Y' => out.push(if next.is_some_and(is_vowel) { b'Y' } else { b'I' }),
            b'P' if next == Some(b'H') => {
                out.push(b'F');
                i += 1;
            }
            b'V' | b'W' => out.push(b'B'),
            b'Z' => out.push(b'S'),
            b'H' => {}
            b'X' => out.extend_from_slice(b"KS"),
            _ => out.push(c),
        }
        i += 1;
    }
    out.dedup();
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::key;

    #[test]
    fn spanish_equivalences() {
        assert_eq!(key("VASQUEZ"), key("BASQUES"));
        assert_eq!(key("VELASQUEZ"), key("VELAZQUEZ"));
        assert_eq!(key("CEVALLOS"), key("ZEBALLOS"));
        assert_eq!(key("GIMENEZ"), key("JIMENEZ"));
        assert_eq!(key("HERRERA"), key("ERRERA"));
        assert_eq!(key("YUPANQUI"), key("LLUPANQUI"));
        assert_eq!(key("QUISPE"), key("KISPE"));
        assert_eq!(key("GUERRA"), "GERA");
        assert_eq!(key("GUILLEN"), "GIYEN");
        assert_eq!(key("CHAVEZ"), key("CHABES"));
        assert_eq!(key("RAPHAEL"), key("RAFAEL"));
        assert_eq!(key("REY"), key("REI"));
    }

    #[test]
    fn keeps_differences() {
        assert_ne!(key("CASTRO"), key("CASTILLO"));
        assert_ne!(key("GARCIA"), key("JARCIA").replace('J', "X"));
        assert_eq!(key("CARLOS"), "KARLOS");
        assert_eq!(key("CHACHA"), "XAXA");
        assert_eq!(key("MAXIMO"), "MAKSIMO");
        assert_eq!(key("ACCION"), "AKSION");
    }
}
