//! Métricas de calidad de captura.

use ::image::GrayImage;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ukuk_core::{Finding, Layer, Severity};

pub const BLUR_THRESHOLD: f64 = 100.0;
pub const MIN_SHORT_SIDE: u32 = 600;
pub const MIN_MEGAPIXELS: f64 = 0.4;
pub const DARK_THRESHOLD: f64 = 0.25;
pub const GLARE_MIN_RATIO: f64 = 0.02;
pub const GLARE_MAX_RATIO: f64 = 0.6;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct QualityMetrics {
    /// Varianza del laplaciano (bajo = borroso).
    pub blur_variance: f64,
    /// Brillo medio 0..1.
    pub brightness: f64,
    /// Desviación estándar de la luminancia 0..1.
    pub contrast: f64,
    /// Fracción de píxeles con luminancia ≥ 250.
    pub glare_ratio: f64,
    pub megapixels: f64,
    /// Máxima fracción saturada en una celda de una grilla 8×8 (brillo concentrado).
    #[serde(skip)]
    pub glare_peak: f64,
}

fn round(v: f64, d: i32) -> f64 {
    let m = 10f64.powi(d);
    (v * m).round() / m
}

pub fn laplacian_variance(g: &GrayImage) -> f64 {
    let (w, h) = g.dimensions();
    if w < 3 || h < 3 {
        return 0.0;
    }
    let px = |x: u32, y: u32| f64::from(g.get_pixel(x, y).0[0]);
    let (mut sum, mut sum2, mut n) = (0.0, 0.0, 0.0);
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let l = px(x - 1, y) + px(x + 1, y) + px(x, y - 1) + px(x, y + 1) - 4.0 * px(x, y);
            sum += l;
            sum2 += l * l;
            n += 1.0;
        }
    }
    let mean = sum / n;
    sum2 / n - mean * mean
}

pub fn measure(g: &GrayImage, megapixels: f64) -> QualityMetrics {
    let (w, h) = g.dimensions();
    let n = f64::from(w) * f64::from(h);
    let (mut sum, mut sum2, mut glare) = (0.0, 0.0, 0u64);
    let mut cells = [[(0u64, 0u64); 8]; 8];
    for (x, y, p) in g.enumerate_pixels() {
        let v = f64::from(p.0[0]);
        sum += v;
        sum2 += v * v;
        let cell = &mut cells[(y * 8 / h.max(1)) as usize][(x * 8 / w.max(1)) as usize];
        cell.1 += 1;
        if p.0[0] >= 250 {
            glare += 1;
            cell.0 += 1;
        }
    }
    let n = n.max(1.0);
    let mean = sum / n;
    let std = (sum2 / n - mean * mean).max(0.0).sqrt();
    let glare_peak = cells
        .iter()
        .flatten()
        .filter(|c| c.1 > 0)
        .map(|c| c.0 as f64 / c.1 as f64)
        .fold(0.0, f64::max);
    QualityMetrics {
        blur_variance: round(laplacian_variance(g), 1),
        brightness: round(mean / 255.0, 4),
        contrast: round(std / 255.0, 4),
        glare_ratio: round(glare as f64 / n, 4),
        megapixels: round(megapixels, 4),
        glare_peak,
    }
}

pub fn findings(m: &QualityMetrics, width: u32, height: u32) -> Vec<Finding> {
    let mut out = Vec::new();
    if m.blur_variance < BLUR_THRESHOLD {
        let confidence = 0.6 + 0.35 * (1.0 - m.blur_variance / BLUR_THRESHOLD);
        out.push(
            Finding::new(
                "image.blur",
                Layer::Quality,
                Severity::Medium,
                confidence,
                "La imagen está borrosa; los detalles finos (texto pequeño, bordes) no son confiables.",
            )
            .with_evidence(json!({ "blur_variance": m.blur_variance, "threshold": BLUR_THRESHOLD })),
        );
    }
    if width.min(height) < MIN_SHORT_SIDE || m.megapixels < MIN_MEGAPIXELS {
        out.push(
            Finding::new(
                "image.low_resolution",
                Layer::Quality,
                Severity::Medium,
                0.9,
                format!("Resolución baja ({width}×{height}); se recomienda una captura de al menos {MIN_SHORT_SIDE} px por lado."),
            )
            .with_evidence(json!({ "width": width, "height": height, "megapixels": m.megapixels })),
        );
    }
    // El papel blanco escaneado satura casi toda la imagen: solo se considera
    // reflejo un brillo saturado parcial y concentrado.
    if m.glare_ratio > GLARE_MIN_RATIO && m.glare_ratio < GLARE_MAX_RATIO && m.glare_peak > 0.5 {
        out.push(
            Finding::new(
                "image.glare",
                Layer::Quality,
                Severity::Low,
                0.6,
                "Hay reflejos o zonas sobreexpuestas que pueden ocultar información.",
            )
            .with_evidence(json!({ "glare_ratio": m.glare_ratio, "glare_peak": round(m.glare_peak, 3) })),
        );
    }
    if m.brightness < DARK_THRESHOLD {
        out.push(
            Finding::new(
                "image.too_dark",
                Layer::Quality,
                Severity::Medium,
                0.85,
                "La imagen está demasiado oscura.",
            )
            .with_evidence(json!({ "brightness": m.brightness, "threshold": DARK_THRESHOLD })),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::testutil::*;
    use ::image::imageops::{FilterType, blur};
    use ::image::{GrayImage, Luma};

    fn codes(f: &[Finding]) -> Vec<&str> {
        f.iter().map(|f| f.code.as_str()).collect()
    }

    #[test]
    fn sharp_vs_blurry() {
        let sharp = noise_gray(800, 800, 3);
        let blurry = blur(&sharp, 4.0);
        let ms = measure(&sharp, 0.64);
        let mb = measure(&blurry, 0.64);
        assert!(ms.blur_variance > 1000.0, "{}", ms.blur_variance);
        assert!(mb.blur_variance < BLUR_THRESHOLD, "{}", mb.blur_variance);
        assert!(!codes(&findings(&ms, 800, 800)).contains(&"image.blur"));
        assert!(codes(&findings(&mb, 800, 800)).contains(&"image.blur"));
    }

    #[test]
    fn dark_and_resolution() {
        let dark = GrayImage::from_pixel(300, 200, Luma([20]));
        let m = measure(&dark, 0.06);
        assert!(m.brightness < 0.1);
        assert_eq!(m.contrast, 0.0);
        let c = findings(&m, 300, 200);
        assert!(codes(&c).contains(&"image.too_dark"));
        assert!(codes(&c).contains(&"image.low_resolution"));
        assert!(codes(&c).contains(&"image.blur"));
    }

    #[test]
    fn glare_is_localized_saturation() {
        let mut g = ::image::imageops::resize(&noise_gray(800, 800, 4), 800, 800, FilterType::Nearest);
        for p in g.pixels_mut() {
            p.0[0] = p.0[0] / 2 + 60;
        }
        let m = measure(&g, 0.64);
        assert!(!codes(&findings(&m, 800, 800)).contains(&"image.glare"));
        for y in 100..250 {
            for x in 100..250 {
                g.put_pixel(x, y, Luma([255]));
            }
        }
        let m = measure(&g, 0.64);
        assert!(m.glare_ratio > 0.03);
        assert!(codes(&findings(&m, 800, 800)).contains(&"image.glare"));
        // un escaneo de papel blanco no es reflejo
        let white = GrayImage::from_pixel(800, 800, Luma([253]));
        assert!(!codes(&findings(&measure(&white, 0.64), 800, 800)).contains(&"image.glare"));
    }
}
