//! Utilidades mínimas de sintaxis PDF sobre bytes crudos (sin renderizar).

pub fn is_whitespace(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n' | b'\x0c' | b'\0')
}

pub fn is_delimiter(b: u8) -> bool {
    matches!(
        b,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

pub fn skip_ws(data: &[u8], mut i: usize) -> usize {
    while i < data.len() && is_whitespace(data[i]) {
        i += 1;
    }
    i
}

/// Cadena literal `( ... )` con anidamiento y escapes. Devuelve (bytes, fin).
pub fn literal_string(data: &[u8], start: usize) -> Option<(Vec<u8>, usize)> {
    if data.get(start) != Some(&b'(') {
        return None;
    }
    let mut out = Vec::new();
    let mut depth = 1;
    let mut i = start + 1;
    while i < data.len() {
        let c = data[i];
        match c {
            b'\\' => {
                i += 1;
                let e = *data.get(i)?;
                match e {
                    b'n' => out.push(b'\n'),
                    b'r' => out.push(b'\r'),
                    b't' => out.push(b'\t'),
                    b'b' => out.push(8),
                    b'f' => out.push(12),
                    b'\r' => {
                        if data.get(i + 1) == Some(&b'\n') {
                            i += 1;
                        }
                    }
                    b'\n' => {}
                    b'0'..=b'7' => {
                        let mut v = u32::from(e - b'0');
                        for _ in 0..2 {
                            match data.get(i + 1) {
                                Some(d @ b'0'..=b'7') => {
                                    v = v * 8 + u32::from(d - b'0');
                                    i += 1;
                                }
                                _ => break,
                            }
                        }
                        out.push((v & 0xFF) as u8);
                    }
                    other => out.push(other),
                }
            }
            b'(' => {
                depth += 1;
                out.push(c);
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some((out, i + 1));
                }
                out.push(c);
            }
            _ => out.push(c),
        }
        i += 1;
    }
    None
}

/// Cadena hexadecimal `< ... >`.
pub fn hex_string(data: &[u8], start: usize) -> Option<(Vec<u8>, usize)> {
    if data.get(start) != Some(&b'<') || data.get(start + 1) == Some(&b'<') {
        return None;
    }
    let end = start + 1 + memchr::memchr(b'>', &data[start + 1..])?;
    let digits: Vec<u8> = data[start + 1..end]
        .iter()
        .copied()
        .filter(u8::is_ascii_hexdigit)
        .collect();
    let mut out = Vec::with_capacity(digits.len() / 2 + 1);
    for pair in digits.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = pair.get(1).map_or(Some(0), |c| (*c as char).to_digit(16))?;
        out.push((hi * 16 + lo) as u8);
    }
    Some((out, end + 1))
}

pub fn string_at(data: &[u8], start: usize) -> Option<(Vec<u8>, usize)> {
    literal_string(data, start).or_else(|| hex_string(data, start))
}

/// Texto de una cadena PDF: UTF-16BE con BOM o PDFDocEncoding (≈ Latin-1).
pub fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    bytes.iter().map(|b| char::from(*b)).collect()
}

/// Busca `/Key` como nombre completo (no prefijo de otro nombre).
pub fn find_key(data: &[u8], key: &[u8], from: usize) -> Option<usize> {
    let mut pos = from;
    while pos < data.len() {
        let rel = memchr::memmem::find(&data[pos..], key)?;
        let at = pos + rel;
        let after = data.get(at + key.len()).copied();
        if after.is_none_or(|b| is_whitespace(b) || is_delimiter(b)) {
            return Some(at);
        }
        pos = at + 1;
    }
    None
}

/// Todas las posiciones de `/Key`.
pub fn find_all_keys(data: &[u8], key: &[u8]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(at) = find_key(data, key, pos) {
        out.push(at);
        pos = at + 1;
    }
    out
}

/// Valor de cadena después de `/Key` (en la posición dada).
pub fn string_value_after(data: &[u8], key_pos: usize, key_len: usize) -> Option<Vec<u8>> {
    let i = skip_ws(data, key_pos + key_len);
    string_at(data, i).map(|(s, _)| s)
}

/// Entero después de `/Key`.
pub fn int_after(data: &[u8], key_pos: usize, key_len: usize) -> Option<i64> {
    let mut i = skip_ws(data, key_pos + key_len);
    let start = i;
    if matches!(data.get(i), Some(b'-' | b'+')) {
        i += 1;
    }
    while i < data.len() && data[i].is_ascii_digit() {
        i += 1;
    }
    std::str::from_utf8(&data[start..i]).ok()?.parse().ok()
}

/// Referencia indirecta `N G R` después de `/Key`.
pub fn ref_after(data: &[u8], key_pos: usize, key_len: usize) -> Option<(u32, u32)> {
    let rest = &data[skip_ws(data, key_pos + key_len)..];
    let text = std::str::from_utf8(&rest[..rest.len().min(32)])
        .ok()
        .or_else(|| {
            let n = rest.iter().take(32).take_while(|b| b.is_ascii()).count();
            std::str::from_utf8(&rest[..n]).ok()
        })?;
    let mut it = text.split_ascii_whitespace();
    let n = it.next()?.parse().ok()?;
    let g = it.next()?.parse().ok()?;
    let r = it.next()?;
    r.starts_with('R').then_some((n, g))
}

/// Diccionario `<< ... >>` que empieza en `start` (con anidamiento); devuelve el rango.
pub fn dict_at(data: &[u8], start: usize) -> Option<(usize, usize)> {
    if !data[start..].starts_with(b"<<") {
        return None;
    }
    let mut depth = 0i32;
    let mut i = start;
    while i + 1 < data.len() {
        match (data[i], data[i + 1]) {
            (b'<', b'<') => {
                depth += 1;
                i += 2;
            }
            (b'>', b'>') => {
                depth -= 1;
                i += 2;
                if depth == 0 {
                    return Some((start, i));
                }
            }
            (b'(', _) => i = literal_string(data, i).map_or(i + 1, |(_, e)| e),
            _ => i += 1,
        }
    }
    None
}

/// Diccionario de un objeto indirecto `N G obj << ... >>` en los bytes crudos.
pub fn object_dict(data: &[u8], num: u32, gen_: u32) -> Option<&[u8]> {
    let header = format!("{num} {gen_} obj");
    let mut pos = 0;
    let mut last = None;
    while let Some(rel) = memchr::memmem::find(&data[pos..], header.as_bytes()) {
        let at = pos + rel;
        let before_ok = at == 0 || !data[at - 1].is_ascii_digit();
        if before_ok {
            last = Some(at + header.len());
        }
        pos = at + 1;
    }
    let i = skip_ws(data, last?);
    let (s, e) = dict_at(data, i)?;
    Some(&data[s..e])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_strings() {
        let (s, end) = literal_string(b"(a\\(b\\) (c) \\101\\n)x", 0).unwrap();
        assert_eq!(s, b"a(b) (c) A\n");
        assert_eq!(end, 19);
        assert!(literal_string(b"(unterminated", 0).is_none());
    }

    #[test]
    fn hex_strings_and_text() {
        let (s, _) = hex_string(b"<FEFF00480069>", 0).unwrap();
        assert_eq!(decode_text(&s), "Hi");
        let (s, _) = hex_string(b"<41 4>", 0).unwrap();
        assert_eq!(s, b"A@");
        assert!(hex_string(b"<<", 0).is_none());
        assert_eq!(decode_text(b"Caf\xe9"), "Café");
    }

    #[test]
    fn keys_and_values() {
        let d = b"<< /Producer (X) /ProducerExtra 1 /Count 3 /Info 12 0 R >>";
        let p = find_key(d, b"/Producer", 0).unwrap();
        assert_eq!(string_value_after(d, p, 9).unwrap(), b"X");
        assert_eq!(find_all_keys(d, b"/Producer").len(), 1);
        let c = find_key(d, b"/Count", 0).unwrap();
        assert_eq!(int_after(d, c, 6), Some(3));
        let i = find_key(d, b"/Info", 0).unwrap();
        assert_eq!(ref_after(d, i, 5), Some((12, 0)));
    }

    #[test]
    fn dicts_and_objects() {
        let d = b"1 0 obj << /A << /B (>>) >> >> endobj 11 0 obj <</X 1>> endobj";
        assert_eq!(object_dict(d, 1, 0).unwrap(), b"<< /A << /B (>>) >> >>");
        assert_eq!(object_dict(d, 11, 0).unwrap(), b"<</X 1>>");
        assert!(object_dict(d, 2, 0).is_none());
    }
}
