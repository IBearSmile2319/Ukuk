//! Comprobación del manejador de seguridad estándar con contraseña de usuario
//! vacía: distingue un PDF con restricciones de propietario (se abre sin
//! contraseña) de uno que realmente exige contraseña para abrirse.

use aes::Aes128;
use aes::cipher::{BlockCipherEncrypt, KeyInit};
use md5::{Digest, Md5};
use sha2::{Sha256, Sha384, Sha512};

use super::syntax::{find_key, int_after, object_dict, ref_after, skip_ws, string_at, string_value_after};

const PAD: [u8; 32] = [
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Encryption {
    None,
    /// Cifrado, pero la contraseña de usuario está vacía.
    OpensWithoutPassword { revision: i64 },
    PasswordRequired { revision: i64 },
    /// Manejador no estándar (certificados, etc.): no se puede abrir.
    Unsupported { filter: String },
}

#[derive(Debug, Default)]
struct StdParams {
    filter: String,
    revision: i64,
    length_bits: i64,
    p: i64,
    o: Vec<u8>,
    u: Vec<u8>,
    encrypt_metadata: bool,
    id0: Vec<u8>,
}

fn rc4(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut s: [u8; 256] = std::array::from_fn(|i| i as u8);
    let mut j = 0u8;
    for i in 0..256 {
        j = j.wrapping_add(s[i]).wrapping_add(key[i % key.len()]);
        s.swap(i, j as usize);
    }
    let (mut i, mut j) = (0u8, 0u8);
    data.iter()
        .map(|b| {
            i = i.wrapping_add(1);
            j = j.wrapping_add(s[i as usize]);
            s.swap(i as usize, j as usize);
            b ^ s[s[i as usize].wrapping_add(s[j as usize]) as usize]
        })
        .collect()
}

/// Algoritmo 2 (ISO 32000-1, 7.6.3.3) con contraseña vacía.
fn file_key(p: &StdParams) -> Vec<u8> {
    let n = if p.revision == 2 { 5 } else { (p.length_bits / 8).clamp(5, 16) as usize };
    let mut h = Md5::new();
    h.update(PAD);
    h.update(&p.o);
    h.update((p.p as i32).to_le_bytes());
    h.update(&p.id0);
    if p.revision >= 4 && !p.encrypt_metadata {
        h.update([0xFF; 4]);
    }
    let mut key = h.finalize().to_vec();
    if p.revision >= 3 {
        for _ in 0..50 {
            key = Md5::digest(&key[..n]).to_vec();
        }
    }
    key.truncate(n);
    key
}

/// Algoritmos 4 y 5: valida la contraseña de usuario vacía (RC4/AES-128).
fn check_legacy(p: &StdParams) -> bool {
    let key = file_key(p);
    if p.revision == 2 {
        return p.u.len() >= 32 && rc4(&key, &PAD) == p.u[..32];
    }
    let mut h = Md5::new();
    h.update(PAD);
    h.update(&p.id0);
    let mut x = rc4(&key, &h.finalize());
    for i in 1..=19u8 {
        let k: Vec<u8> = key.iter().map(|b| b ^ i).collect();
        x = rc4(&k, &x);
    }
    p.u.len() >= 16 && x[..16] == p.u[..16]
}

fn aes128_cbc_encrypt(key: &[u8], iv: &[u8], data: &[u8]) -> Vec<u8> {
    let cipher = Aes128::new_from_slice(key).expect("clave de 16 bytes");
    let mut prev = [0u8; 16];
    prev.copy_from_slice(iv);
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks_exact(16) {
        let mut block = aes::Block::default();
        for (i, b) in block.iter_mut().enumerate() {
            *b = chunk[i] ^ prev[i];
        }
        cipher.encrypt_block(&mut block);
        prev.copy_from_slice(&block);
        out.extend_from_slice(&block);
    }
    out
}

/// Algoritmo 2.B (ISO 32000-2) para R6.
fn hash_2b(password: &[u8], salt: &[u8], udata: &[u8]) -> Vec<u8> {
    let mut k = {
        let mut h = Sha256::new();
        h.update(password);
        h.update(salt);
        h.update(udata);
        h.finalize().to_vec()
    };
    let mut round = 0u32;
    loop {
        let mut k1 = Vec::with_capacity(64 * (password.len() + k.len() + udata.len()));
        for _ in 0..64 {
            k1.extend_from_slice(password);
            k1.extend_from_slice(&k);
            k1.extend_from_slice(udata);
        }
        let e = aes128_cbc_encrypt(&k[..16], &k[16..32], &k1);
        let m = e[..16].iter().map(|b| u32::from(*b)).sum::<u32>() % 3;
        k = match m {
            0 => Sha256::digest(&e).to_vec(),
            1 => Sha384::digest(&e).to_vec(),
            _ => Sha512::digest(&e).to_vec(),
        };
        round += 1;
        if round >= 64 && u32::from(*e.last().unwrap_or(&0)) <= round - 32 {
            break;
        }
    }
    k.truncate(32);
    k
}

fn check_aes256(p: &StdParams) -> bool {
    if p.u.len() < 40 {
        return false;
    }
    let salt = &p.u[32..40];
    let hash = if p.revision == 5 {
        let mut h = Sha256::new();
        h.update(salt);
        h.finalize().to_vec()
    } else {
        hash_2b(b"", salt, b"")
    };
    hash == p.u[..32]
}

fn read_params(raw: &[u8]) -> Option<StdParams> {
    let at = find_key(raw, b"/Encrypt", 0)?;
    // El /Encrypt del último tráiler manda: se busca la última aparición.
    let mut last = at;
    while let Some(next) = find_key(raw, b"/Encrypt", last + 1) {
        last = next;
    }
    let dict: &[u8] = match ref_after(raw, last, 8) {
        Some((n, g)) => object_dict(raw, n, g)?,
        None => {
            let i = skip_ws(raw, last + 8);
            let (s, e) = super::syntax::dict_at(raw, i)?;
            &raw[s..e]
        }
    };
    let name_after = |key: &[u8]| -> Option<String> {
        let k = find_key(dict, key, 0)?;
        let i = skip_ws(dict, k + key.len());
        let rest = dict.get(i..)?.strip_prefix(b"/")?;
        let end = rest
            .iter()
            .position(|b| super::syntax::is_whitespace(*b) || super::syntax::is_delimiter(*b))
            .unwrap_or(rest.len());
        Some(String::from_utf8_lossy(&rest[..end]).into_owned())
    };
    let int = |key: &[u8]| find_key(dict, key, 0).and_then(|k| int_after(dict, k, key.len()));
    let string = |key: &[u8]| find_key(dict, key, 0).and_then(|k| string_value_after(dict, k, key.len()));
    let id0 = find_key(raw, b"/ID", 0)
        .and_then(|k| {
            let i = skip_ws(raw, k + 3);
            (raw.get(i) == Some(&b'[')).then(|| skip_ws(raw, i + 1))
        })
        .and_then(|i| string_at(raw, i).map(|(s, _)| s))
        .unwrap_or_default();
    let encrypt_metadata = find_key(dict, b"/EncryptMetadata", 0)
        .map(|k| !dict[skip_ws(dict, k + 16)..].starts_with(b"false"))
        .unwrap_or(true);
    Some(StdParams {
        filter: name_after(b"/Filter").unwrap_or_default(),
        revision: int(b"/R").unwrap_or(0),
        length_bits: int(b"/Length").unwrap_or(40),
        p: int(b"/P").unwrap_or(0),
        o: string(b"/O").unwrap_or_default(),
        u: string(b"/U").unwrap_or_default(),
        encrypt_metadata,
        id0,
    })
}

/// Determina si el PDF está cifrado y si se puede abrir sin contraseña.
pub fn check(raw: &[u8]) -> Encryption {
    if find_key(raw, b"/Encrypt", 0).is_none() {
        return Encryption::None;
    }
    let Some(p) = read_params(raw) else {
        return Encryption::Unsupported { filter: "desconocido".into() };
    };
    if p.filter != "Standard" {
        return Encryption::Unsupported { filter: p.filter };
    }
    let opens = match p.revision {
        2..=4 => check_legacy(&p),
        5 | 6 => check_aes256(&p),
        _ => false,
    };
    if opens {
        Encryption::OpensWithoutPassword { revision: p.revision }
    } else {
        Encryption::PasswordRequired { revision: p.revision }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn rc4_known_vector() {
        // RFC 6229 / vector clásico "Key" / "Plaintext".
        assert_eq!(hex(&rc4(b"Key", b"Plaintext")), "bbf316e8d940af0ad3");
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn hexstr(b: &[u8]) -> String {
        format!("<{}>", hex(b))
    }

    /// Construye un PDF cifrado R3 (RC4 128) con contraseña de usuario `user`.
    pub(crate) fn encrypted_pdf(user_password_empty: bool) -> Vec<u8> {
        let id0 = b"0123456789abcdef".to_vec();
        let o = vec![0x11u8; 32];
        let p = -4i64;
        let mut params = StdParams {
            filter: "Standard".into(),
            revision: 3,
            length_bits: 128,
            p,
            o: o.clone(),
            u: vec![],
            encrypt_metadata: true,
            id0: id0.clone(),
        };
        let key = file_key(&params);
        let mut h = Md5::new();
        h.update(PAD);
        h.update(&id0);
        let mut x = rc4(&key, &h.finalize());
        for i in 1..=19u8 {
            let k: Vec<u8> = key.iter().map(|b| b ^ i).collect();
            x = rc4(&k, &x);
        }
        x.extend_from_slice(&[0u8; 16]);
        if !user_password_empty {
            x[0] ^= 0xFF;
        }
        params.u = x;
        format!(
            "%PDF-1.6\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n4 0 obj << /Filter /Standard /V 2 /R 3 /Length 128 /P {p} /O {} /U {} >> endobj\ntrailer << /Root 1 0 R /Encrypt 4 0 R /ID [{} {}] >>\nstartxref\n0\n%%EOF\n",
            hexstr(&o),
            hexstr(&params.u),
            hexstr(&id0),
            hexstr(&id0)
        )
        .into_bytes()
    }

    #[test]
    fn detects_owner_only_vs_user_password() {
        assert_eq!(check(&encrypted_pdf(true)), Encryption::OpensWithoutPassword { revision: 3 });
        assert_eq!(check(&encrypted_pdf(false)), Encryption::PasswordRequired { revision: 3 });
        assert_eq!(check(b"%PDF-1.4 trailer << /Root 1 0 R >>"), Encryption::None);
    }

    #[test]
    fn non_standard_handler() {
        let pdf = b"%PDF-1.7\n5 0 obj << /Filter /Adobe.PubSec /V 4 >> endobj\ntrailer << /Encrypt 5 0 R >>";
        assert_eq!(check(pdf), Encryption::Unsupported { filter: "Adobe.PubSec".into() });
    }

    #[test]
    fn aes256_r6_empty_password() {
        let salt = b"saltsalt";
        let mut u = hash_2b(b"", salt, b"");
        u.extend_from_slice(salt);
        u.extend_from_slice(b"keysaltk");
        let p = StdParams { filter: "Standard".into(), revision: 6, u: u.clone(), ..Default::default() };
        assert!(check_aes256(&p));
        u[0] ^= 1;
        let p = StdParams { filter: "Standard".into(), revision: 6, u, ..Default::default() };
        assert!(!check_aes256(&p));
    }
}
