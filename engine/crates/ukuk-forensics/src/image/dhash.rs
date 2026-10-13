//! Huella perceptual dHash de 64 bits (diferencias horizontales en 9×8).

use ::image::DynamicImage;
use ::image::imageops::FilterType;

pub fn dhash(img: &DynamicImage) -> u64 {
    let small = img.resize_exact(9, 8, FilterType::Triangle).to_luma8();
    let mut hash = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            let left = small.get_pixel(x, y).0[0];
            let right = small.get_pixel(x + 1, y).0[0];
            hash = (hash << 1) | u64::from(left > right);
        }
    }
    hash
}

pub fn to_hex(h: u64) -> String {
    format!("{h:016x}")
}

pub fn hamming_u64(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// Distancia de Hamming entre dos dHash en hexadecimal (16 caracteres).
/// Devuelve `None` si alguno no es un hex válido de 64 bits.
pub fn hamming(a: &str, b: &str) -> Option<u32> {
    let parse = |s: &str| {
        let s = s.trim();
        (s.len() == 16)
            .then(|| u64::from_str_radix(s, 16).ok())
            .flatten()
    };
    Some(hamming_u64(parse(a)?, parse(b)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::testutil::*;
    use ::image::{DynamicImage, Rgb};

    #[test]
    fn hamming_distance() {
        assert_eq!(hamming("0000000000000000", "000000000000000f"), Some(4));
        assert_eq!(hamming("ffffffffffffffff", "0000000000000000"), Some(64));
        assert_eq!(hamming("abc", "0000000000000000"), None);
        assert_eq!(hamming("zzzzzzzzzzzzzzzz", "0000000000000000"), None);
    }

    #[test]
    fn similar_images_have_close_hashes() {
        let a = textured_rgb(400, 300, 10);
        let ha = dhash(&DynamicImage::ImageRgb8(a.clone()));
        // Recomprimida y reescalada: casi idéntica.
        let b = decode_rgb(&encode_jpeg(&a, 60));
        let b = DynamicImage::ImageRgb8(b).resize_exact(300, 225, FilterType::Triangle);
        let hb = dhash(&b);
        assert!(hamming_u64(ha, hb) <= 6, "{}", hamming_u64(ha, hb));
        // Otra imagen: lejos.
        let mut c = textured_rgb(400, 300, 11);
        for (x, _, p) in c.enumerate_pixels_mut() {
            if x > 200 {
                *p = Rgb([255 - p.0[0], 255 - p.0[1], 255 - p.0[2]]);
            }
        }
        let hc = dhash(&DynamicImage::ImageRgb8(c));
        assert!(hamming_u64(ha, hc) > 10, "{}", hamming_u64(ha, hc));
        assert_eq!(to_hex(ha).len(), 16);
    }
}
