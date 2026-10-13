//! Detección de copy-move: bloques solapados no planos con la misma firma
//! cuantizada, agrupados por vector de desplazamiento. Un parche clonado dentro
//! de la misma imagen genera muchos pares con el mismo desplazamiento.

use std::collections::HashMap;

use ::image::GrayImage;
use ::image::imageops::FilterType;
use ::image::metadata::Orientation;
use serde_json::json;
use ukuk_core::{Finding, Layer, Region, Severity};

const BLOCK: u32 = 8;
const MAX_SIDE: u32 = 1024;
/// Desviación estándar mínima para considerar un bloque (evita papel liso).
const MIN_STD: f64 = 10.0;
/// Paso de cuantización de las medias de celdas 2×2.
const QUANT: u32 = 16;
/// Grupos con más bloques idénticos son texturas repetitivas (líneas, tramas).
const MAX_GROUP: usize = 8;
const MIN_SHIFT: f64 = 24.0;
/// Mínimo de bloques que comparten desplazamiento para reportar.
pub const MIN_BLOCKS: usize = 64;
const MAX_REPORTS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CopyMoveMatch {
    /// Rectángulos en píxeles de la imagen original: (x, y, w, h).
    pub source: (u32, u32, u32, u32),
    pub target: (u32, u32, u32, u32),
    pub shift: (i32, i32),
    pub blocks: usize,
}

struct Integral {
    w: usize,
    sum: Vec<u64>,
    sq: Vec<u64>,
}

impl Integral {
    fn new(g: &GrayImage) -> Self {
        let (w, h) = (g.width() as usize, g.height() as usize);
        let mut sum = vec![0u64; (w + 1) * (h + 1)];
        let mut sq = vec![0u64; (w + 1) * (h + 1)];
        for y in 0..h {
            let (mut rs, mut rq) = (0u64, 0u64);
            for x in 0..w {
                let v = u64::from(g.get_pixel(x as u32, y as u32).0[0]);
                rs += v;
                rq += v * v;
                let i = (y + 1) * (w + 1) + x + 1;
                sum[i] = sum[i - (w + 1)] + rs;
                sq[i] = sq[i - (w + 1)] + rq;
            }
        }
        Self { w: w + 1, sum, sq }
    }

    fn rect(t: &[u64], stride: usize, x: usize, y: usize, s: usize) -> u64 {
        t[(y + s) * stride + x + s] + t[y * stride + x]
            - t[y * stride + x + s]
            - t[(y + s) * stride + x]
    }
}

fn bbox(points: impl Iterator<Item = (u32, u32)>) -> (u32, u32, u32, u32) {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0, 0);
    for (x, y) in points {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x + BLOCK);
        y1 = y1.max(y + BLOCK);
    }
    (x0, y0, x1 - x0, y1 - y0)
}

pub fn detect(gray: &GrayImage) -> Vec<CopyMoveMatch> {
    let (ow, oh) = gray.dimensions();
    let factor = ow.max(oh).div_ceil(MAX_SIDE).max(1);
    let scaled;
    let g = if factor > 1 {
        scaled = ::image::imageops::resize(gray, ow / factor, oh / factor, FilterType::Triangle);
        &scaled
    } else {
        gray
    };
    let (w, h) = g.dimensions();
    if w < BLOCK * 4 || h < BLOCK * 4 {
        return Vec::new();
    }
    let it = Integral::new(g);
    let n_px = f64::from(BLOCK * BLOCK);
    let mut keyed: Vec<(u64, u32)> = Vec::new();
    for y in 0..=(h - BLOCK) {
        for x in 0..=(w - BLOCK) {
            let (xs, ys) = (x as usize, y as usize);
            let s = Integral::rect(&it.sum, it.w, xs, ys, BLOCK as usize) as f64;
            let q = Integral::rect(&it.sq, it.w, xs, ys, BLOCK as usize) as f64;
            let mean = s / n_px;
            if (q / n_px - mean * mean) < MIN_STD * MIN_STD {
                continue;
            }
            // Firma: 16 celdas de 2×2, 4 bits cada una.
            let mut key = 0u64;
            for cy in 0..4 {
                for cx in 0..4 {
                    let c = Integral::rect(&it.sum, it.w, xs + cx * 2, ys + cy * 2, 2) as u32 / 4;
                    key = (key << 4) | u64::from(c / QUANT);
                }
            }
            keyed.push((key, y * w + x));
        }
    }
    keyed.sort_unstable();

    let mut by_shift: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for group in keyed.chunk_by(|a, b| a.0 == b.0) {
        if group.len() < 2 || group.len() > MAX_GROUP {
            continue;
        }
        for (i, a) in group.iter().enumerate() {
            for b in &group[i + 1..] {
                let (ax, ay) = ((a.1 % w) as i32, (a.1 / w) as i32);
                let (bx, by) = ((b.1 % w) as i32, (b.1 / w) as i32);
                // Vector canónico: dy > 0, o dy == 0 y dx > 0.
                let (src, dx, dy) = if (by, bx) > (ay, ax) {
                    (a.1, bx - ax, by - ay)
                } else {
                    (b.1, ax - bx, ay - by)
                };
                if f64::from(dx * dx + dy * dy).sqrt() < MIN_SHIFT {
                    continue;
                }
                by_shift.entry((dx, dy)).or_default().push(src);
            }
        }
    }

    let mut shifts: Vec<((i32, i32), Vec<u32>)> = by_shift
        .into_iter()
        .filter(|(_, v)| v.len() >= MIN_BLOCKS)
        .collect();
    shifts.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(&b.0)));

    let mut out: Vec<CopyMoveMatch> = Vec::new();
    for ((dx, dy), srcs) in shifts {
        // Desplazamientos vecinos suelen ser el mismo clon (efecto de cuantización).
        if out.iter().any(|m| {
            (m.shift.0 - dx * factor as i32).abs() <= 2 * factor as i32
                && (m.shift.1 - dy * factor as i32).abs() <= 2 * factor as i32
        }) {
            continue;
        }
        let src_pts = srcs.iter().map(|p| (p % w, p / w));
        let (sx, sy, sw, sh) = bbox(src_pts);
        let f = factor;
        out.push(CopyMoveMatch {
            source: (sx * f, sy * f, sw * f, sh * f),
            target: (
                (sx as i32 + dx) as u32 * f,
                (sy as i32 + dy) as u32 * f,
                sw * f,
                sh * f,
            ),
            shift: (dx * f as i32, dy * f as i32),
            blocks: srcs.len(),
        });
        if out.len() >= MAX_REPORTS {
            break;
        }
    }
    out
}

pub fn finding(m: &CopyMoveMatch, orientation: Orientation, width: u32, height: u32) -> Finding {
    let to_region = |(x, y, w, h): (u32, u32, u32, u32)| {
        super::orient_region(
            Region::from_pixels(1, x, y, w, h, width, height),
            orientation,
        )
    };
    let confidence = (0.55 + (m.blocks as f64 / MIN_BLOCKS as f64).ln() * 0.1).min(0.85);
    Finding::new(
        "copy_move.duplicated_region",
        Layer::Forensics,
        Severity::High,
        confidence,
        "Una zona de la imagen parece copiada de otra parte del mismo documento (clonado).",
    )
    .with_region(to_region(m.target))
    .with_evidence(json!({
        "source_region": to_region(m.source),
        "shift_px": [m.shift.0, m.shift.1],
        "matching_blocks": m.blocks,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::testutil::*;
    use ::image::imageops::{crop_imm, overlay};

    #[test]
    fn detects_cloned_patch() {
        let mut g = noise_gray(400, 300, 5);
        let patch = crop_imm(&g, 40, 50, 48, 48).to_image();
        overlay(&mut g, &patch, 250, 180);
        let m = detect(&g);
        assert_eq!(m.len(), 1, "{m:?}");
        assert_eq!(m[0].shift, (210, 130));
        assert_eq!(m[0].source, (40, 50, 48, 48));
        assert_eq!(m[0].target, (250, 180, 48, 48));
        let f = finding(&m[0], Orientation::NoTransforms, 400, 300);
        assert_eq!(f.code, "copy_move.duplicated_region");
        assert!(f.confidence > 0.5);
    }

    #[test]
    fn survives_jpeg_recompression() {
        let mut rgb = textured_rgb(480, 360, 8);
        let patch = crop_imm(&rgb, 60, 60, 64, 64).to_image();
        overlay(&mut rgb, &patch, 300, 220);
        let g = ::image::DynamicImage::ImageRgb8(decode_rgb(&encode_jpeg(&rgb, 95))).to_luma8();
        let m = detect(&g);
        assert!(!m.is_empty());
        assert_eq!(m[0].shift, (240, 160));
    }

    #[test]
    fn clean_images_have_no_matches() {
        assert!(detect(&noise_gray(400, 300, 6)).is_empty());
        let g = ::image::DynamicImage::ImageRgb8(textured_rgb(400, 300, 7)).to_luma8();
        assert!(detect(&g).is_empty());
        // Texturas periódicas (rayas) no se reportan.
        let stripes = GrayImage::from_fn(400, 300, |x, _| {
            ::image::Luma([if (x / 4) % 2 == 0 { 0 } else { 255 }])
        });
        assert!(detect(&stripes).is_empty());
        assert!(detect(&GrayImage::new(10, 10)).is_empty());
    }
}
