//! Error Level Analysis: se recomprime a calidad fija y se mide, por bloque,
//! la diferencia media. Zonas que "reaccionan" distinto a la recompresión
//! sugieren un historial de compresión diferente (pegado, retoque). Es una
//! señal ruidosa (bordes y texturas también elevan el error): confianza ≤ 0,6.
//!
//! Para no marcar simplemente "donde hay texto", cada bloque se compara además
//! con los bloques de actividad (gradiente medio) similar: se buscan bloques
//! cuyo error es alto *para su textura*, además de alto en términos absolutos.

use std::io::Cursor;

use ::image::codecs::jpeg::JpegEncoder;
use ::image::metadata::Orientation;
use ::image::{ImageFormat, RgbImage};
use serde::{Deserialize, Serialize};
use serde_json::json;
use ukuk_core::{Finding, Layer, Region, Severity};

pub const RECOMPRESS_QUALITY: u8 = 90;
pub const BLOCK: u32 = 16;
/// Piso absoluto (diferencia media por píxel) para marcar un bloque.
pub const ABS_FLOOR: f64 = 2.0;
/// Además, el bloque debe superar este múltiplo de la media global.
pub const REL_FLOOR: f64 = 2.5;
pub const SIGMAS: f64 = 3.0;
/// z robusto mínimo del error respecto de bloques de textura similar.
const ROBUST_Z: f64 = 3.5;
const ACTIVITY_BUCKETS: usize = 10;
pub const MIN_REGION_BLOCKS: usize = 2;
pub const MAX_REPORTED_REGIONS: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ElaSummary {
    pub mean: f64,
    pub max: f64,
    pub suspicious_regions: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ElaRegion {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub blocks: usize,
    pub mean: f64,
    pub peak: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ElaResult {
    pub summary: ElaSummary,
    pub regions: Vec<ElaRegion>,
    pub threshold: f64,
}

fn round(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Mapa de error medio por bloque y de actividad (gradiente medio de luminancia),
/// ambos de tamaño `cols × rows`.
pub fn block_errors(img: &RgbImage, quality: u8) -> Option<(Vec<f64>, Vec<f64>, u32, u32)> {
    let (w, h) = img.dimensions();
    if w < BLOCK || h < BLOCK {
        return None;
    }
    let mut buf = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, quality)
        .encode_image(img)
        .ok()?;
    let re = ::image::load(Cursor::new(buf), ImageFormat::Jpeg)
        .ok()?
        .to_rgb8();
    let cols = w.div_ceil(BLOCK);
    let rows = h.div_ceil(BLOCK);
    let mut sums = vec![0.0f64; (cols * rows) as usize];
    let mut counts = vec![0u32; (cols * rows) as usize];
    for (y, (row_a, row_b)) in img.rows().zip(re.rows()).enumerate() {
        let by = y as u32 / BLOCK;
        for (x, (a, b)) in row_a.zip(row_b).enumerate() {
            let d: u32 =
                a.0.iter()
                    .zip(b.0.iter())
                    .map(|(p, q)| u32::from(p.abs_diff(*q)))
                    .sum();
            let idx = (by * cols + x as u32 / BLOCK) as usize;
            sums[idx] += f64::from(d) / 3.0;
            counts[idx] += 1;
        }
    }
    let luma = |x: u32, y: u32| {
        let p = img.get_pixel(x, y).0;
        (299 * u32::from(p[0]) + 587 * u32::from(p[1]) + 114 * u32::from(p[2])) as f64 / 1000.0
    };
    let mut act = vec![0.0f64; (cols * rows) as usize];
    for y in 0..h - 1 {
        for x in 0..w - 1 {
            let c = luma(x, y);
            let g = (luma(x + 1, y) - c).abs() + (luma(x, y + 1) - c).abs();
            act[((y / BLOCK) * cols + x / BLOCK) as usize] += g;
        }
    }
    let means = sums
        .iter()
        .zip(&counts)
        .map(|(s, c)| s / f64::from((*c).max(1)))
        .collect();
    let act = act
        .iter()
        .zip(&counts)
        .map(|(s, c)| s / f64::from((*c).max(1)))
        .collect();
    Some((means, act, cols, rows))
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

/// z robusto del error de cada bloque frente a los bloques de su decil de
/// actividad: compara texto con texto y papel con papel.
fn activity_residuals(errs: &[f64], act: &[f64]) -> Vec<f64> {
    let mut order: Vec<usize> = (0..errs.len()).collect();
    order.sort_by(|a, b| act[*a].total_cmp(&act[*b]));
    let mut z = vec![0.0; errs.len()];
    let size = errs.len().div_ceil(ACTIVITY_BUCKETS).max(1);
    for bucket in order.chunks(size) {
        let mut vals: Vec<f64> = bucket.iter().map(|i| errs[*i]).collect();
        let med = median(&mut vals);
        let mut dev: Vec<f64> = bucket.iter().map(|i| (errs[*i] - med).abs()).collect();
        let scale = (median(&mut dev) * 1.4826).max(0.25);
        for i in bucket {
            z[*i] = (errs[*i] - med) / scale;
        }
    }
    z
}

pub fn analyze(img: &RgbImage, quality: u8) -> ElaResult {
    let empty = ElaResult {
        summary: ElaSummary {
            mean: 0.0,
            max: 0.0,
            suspicious_regions: 0,
        },
        regions: Vec::new(),
        threshold: 0.0,
    };
    let Some((errs, act, cols, rows)) = block_errors(img, quality) else {
        return empty;
    };
    let stats = |v: &[f64]| {
        let n = v.len() as f64;
        let m = v.iter().sum::<f64>() / n;
        (
            m,
            (v.iter().map(|e| (e - m).powi(2)).sum::<f64>() / n).sqrt(),
        )
    };
    let (mean, std) = stats(&errs);
    let max = errs.iter().copied().fold(0.0, f64::max);
    let threshold = (mean + SIGMAS * std).max(ABS_FLOOR).max(REL_FLOOR * mean);
    let z = activity_residuals(&errs, &act);
    let flagged: Vec<bool> = errs
        .iter()
        .zip(&z)
        .map(|(e, z)| *e > threshold && *z > ROBUST_Z)
        .collect();

    // Componentes 8-conexas de bloques marcados.
    let mut seen = vec![false; flagged.len()];
    let mut regions = Vec::new();
    for start in 0..flagged.len() {
        if !flagged[start] || seen[start] {
            continue;
        }
        let mut stack = vec![start];
        seen[start] = true;
        let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0, 0);
        let (mut count, mut sum, mut peak) = (0usize, 0.0, 0.0f64);
        while let Some(i) = stack.pop() {
            let (cx, cy) = (i as u32 % cols, i as u32 / cols);
            x0 = x0.min(cx);
            y0 = y0.min(cy);
            x1 = x1.max(cx);
            y1 = y1.max(cy);
            count += 1;
            sum += errs[i];
            peak = peak.max(errs[i]);
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let (nx, ny) = (i64::from(cx) + dx, i64::from(cy) + dy);
                    if nx < 0 || ny < 0 || nx >= i64::from(cols) || ny >= i64::from(rows) {
                        continue;
                    }
                    let j = (ny as u32 * cols + nx as u32) as usize;
                    if flagged[j] && !seen[j] {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
        }
        if count >= MIN_REGION_BLOCKS {
            let (w, h) = img.dimensions();
            let px = x0 * BLOCK;
            let py = y0 * BLOCK;
            regions.push(ElaRegion {
                x: px,
                y: py,
                w: ((x1 + 1) * BLOCK).min(w) - px,
                h: ((y1 + 1) * BLOCK).min(h) - py,
                blocks: count,
                mean: sum / count as f64,
                peak,
            });
        }
    }
    regions.sort_by(|a, b| b.blocks.cmp(&a.blocks).then(b.peak.total_cmp(&a.peak)));
    let suspicious_regions = regions.len();
    regions.truncate(MAX_REPORTED_REGIONS);
    ElaResult {
        summary: ElaSummary {
            mean: round(mean),
            max: round(max),
            suspicious_regions,
        },
        regions,
        threshold,
    }
}

pub fn finding(
    r: &ElaRegion,
    summary: &ElaSummary,
    source_is_jpeg: bool,
    orientation: Orientation,
    width: u32,
    height: u32,
) -> Finding {
    let region = super::orient_region(
        Region::from_pixels(1, r.x, r.y, r.w, r.h, width, height),
        orientation,
    );
    let evidence = json!({
        "blocks": r.blocks,
        "region_mean": round(r.mean),
        "region_peak": round(r.peak),
        "image_mean": summary.mean,
        "block_size": BLOCK,
        "recompress_quality": RECOMPRESS_QUALITY,
        "source_jpeg": source_is_jpeg,
    });
    if source_is_jpeg {
        let confidence = if r.blocks >= 4 { 0.6 } else { 0.45 };
        Finding::new(
            "ela.inconsistent_compression",
            Layer::Forensics,
            Severity::Medium,
            confidence,
            "Una zona muestra un nivel de compresión distinto al resto de la imagen (posible pegado o retoque). Requiere revisión visual: bordes y texturas también elevan este indicador.",
        )
        .with_region(region)
        .with_evidence(evidence)
    } else {
        Finding::new(
            "ela.inconsistent_compression",
            Layer::Forensics,
            Severity::Low,
            0.25,
            "Una zona reacciona distinto a la recompresión, pero la imagen no es JPEG: el ELA es poco concluyente en este formato.",
        )
        .with_region(region)
        .with_evidence(evidence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::testutil::*;
    use ::image::imageops::overlay;

    /// Fondo comprimido dos veces (q=60 y luego q=92) con un parche "fresco"
    /// pegado antes del último guardado.
    fn spliced() -> (RgbImage, (u32, u32, u32, u32)) {
        let base = decode_rgb(&encode_jpeg(&textured_rgb(512, 384, 21), 60));
        let patch =
            ::image::imageops::crop_imm(&textured_rgb(512, 384, 99), 0, 0, 128, 96).to_image();
        let mut doc = base;
        overlay(&mut doc, &patch, 224, 160);
        (decode_rgb(&encode_jpeg(&doc, 92)), (224, 160, 128, 96))
    }

    #[test]
    fn flags_pasted_region() {
        let (img, (px, py, pw, ph)) = spliced();
        let r = analyze(&img, RECOMPRESS_QUALITY);
        assert!(r.summary.suspicious_regions >= 1, "{r:?}");
        let top = r.regions[0];
        let overlap_x = (top.x + top.w).min(px + pw).saturating_sub(top.x.max(px));
        let overlap_y = (top.y + top.h).min(py + ph).saturating_sub(top.y.max(py));
        assert!(overlap_x * overlap_y > (pw * ph) / 3, "{top:?}");
        assert!(r.summary.max > r.summary.mean);
    }

    #[test]
    fn uniform_history_is_clean() {
        let img = decode_rgb(&encode_jpeg(
            &decode_rgb(&encode_jpeg(&textured_rgb(512, 384, 21), 60)),
            92,
        ));
        let r = analyze(&img, RECOMPRESS_QUALITY);
        assert_eq!(r.summary.suspicious_regions, 0, "{r:?}");
    }

    /// Página blanca con "texto" disperso (trazos oscuros), comprimida una vez.
    pub(crate) fn sparse_text_page(seed: u64) -> RgbImage {
        let mut rng = Lcg(seed);
        let mut img = RgbImage::from_pixel(640, 480, ::image::Rgb([245, 245, 240]));
        for line in 0..6u32 {
            let y = 60 + line * 60;
            let mut x = 40;
            while x < 560 {
                let w = 6 + rng.next() % 30;
                for yy in y..y + 14 {
                    for xx in x..(x + w).min(600) {
                        if !(xx + yy + rng.next()).is_multiple_of(3) {
                            img.put_pixel(xx, yy, ::image::Rgb([30, 30, 40]));
                        }
                    }
                }
                x += w + 8 + rng.next() % 12;
            }
        }
        img
    }

    #[test]
    fn sparse_text_document_is_clean() {
        for seed in 1..4 {
            for q in [75, 85, 95] {
                let mut page = sparse_text_page(seed);
                if seed == 3 {
                    // papel con grano (foto)
                    let mut rng = Lcg(9);
                    for p in page.pixels_mut() {
                        let n = (rng.next() % 9) as u8;
                        p.0 = p.0.map(|v| v.saturating_sub(n));
                    }
                }
                let img = decode_rgb(&encode_jpeg(&page, q));
                let r = analyze(&img, RECOMPRESS_QUALITY);
                assert_eq!(r.summary.suspicious_regions, 0, "seed {seed} q {q}: {r:?}");
            }
        }
    }

    #[test]
    fn tiny_image() {
        let r = analyze(&RgbImage::new(8, 8), RECOMPRESS_QUALITY);
        assert_eq!(r.summary.suspicious_regions, 0);
    }

    #[test]
    fn finding_softened_for_png() {
        let region = ElaRegion {
            x: 0,
            y: 0,
            w: 32,
            h: 32,
            blocks: 4,
            mean: 9.0,
            peak: 12.0,
        };
        let s = ElaSummary {
            mean: 2.0,
            max: 12.0,
            suspicious_regions: 1,
        };
        let j = finding(&region, &s, true, Orientation::NoTransforms, 100, 100);
        let p = finding(&region, &s, false, Orientation::NoTransforms, 100, 100);
        assert!(j.confidence <= 0.6 && j.severity == Severity::Medium);
        assert!(p.confidence < j.confidence && p.severity == Severity::Low);
        assert_eq!(j.region.unwrap().w, 0.32);
    }
}
