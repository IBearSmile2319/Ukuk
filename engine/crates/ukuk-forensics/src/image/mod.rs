//! Análisis de imágenes: calidad, huella perceptual, ELA, copy-move y EXIF.

pub mod copy_move;
pub mod dhash;
pub mod ela;
pub mod exif;
pub mod quality;

use std::io::Cursor;

use ::image::imageops::FilterType;
use ::image::metadata::Orientation;
use ::image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use serde_json::json;
use ukuk_core::{Finding, Layer, Region, Severity};

pub use self::ela::ElaSummary;
pub use self::exif::ExifInfo;
pub use self::quality::QualityMetrics;

/// Por encima de este tamaño el ELA se omite (costo de recomprimir).
const ELA_MAX_PIXELS: u64 = 40_000_000;
/// Lado máximo de la imagen usada para métricas de calidad.
const QUALITY_MAX_SIDE: u32 = 1600;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageReport {
    pub width: u32,
    pub height: u32,
    pub dhash: String,
    pub quality: QualityMetrics,
    pub ela: Option<ElaSummary>,
    pub exif: Option<ExifInfo>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageAnalysis {
    pub report: ImageReport,
    pub findings: Vec<Finding>,
    pub format: ImageFormat,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageError(pub String);

impl std::fmt::Display for ImageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ImageError {}

/// Decodifica respetando límites (evita bombas de descompresión) y devuelve la
/// imagen en su orientación de almacenamiento junto con la orientación EXIF.
pub fn decode(bytes: &[u8]) -> Result<(DynamicImage, Orientation, ImageFormat), ImageError> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| ImageError(e.to_string()))?;
    let format = reader
        .format()
        .ok_or_else(|| ImageError("formato de imagen no reconocido".into()))?;
    if !matches!(
        format,
        ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Tiff
    ) {
        return Err(ImageError(format!("formato no soportado: {format:?}")));
    }
    let mut reader = reader;
    let mut limits = Limits::default();
    limits.max_image_width = Some(20_000);
    limits.max_image_height = Some(20_000);
    limits.max_alloc = Some(1 << 30);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| ImageError(e.to_string()))?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let img = DynamicImage::from_decoder(decoder).map_err(|e| ImageError(e.to_string()))?;
    Ok((img, orientation, format))
}

/// Transforma una región medida sobre la imagen almacenada a la orientación de visualización.
pub fn orient_region(r: Region, o: Orientation) -> Region {
    let rot90 = |r: Region| Region::new(r.page, 1.0 - (r.y + r.h), r.x, r.h, r.w);
    let rot180 = |r: Region| Region::new(r.page, 1.0 - (r.x + r.w), 1.0 - (r.y + r.h), r.w, r.h);
    let rot270 = |r: Region| Region::new(r.page, r.y, 1.0 - (r.x + r.w), r.h, r.w);
    let fliph = |r: Region| Region::new(r.page, 1.0 - (r.x + r.w), r.y, r.w, r.h);
    let flipv = |r: Region| Region::new(r.page, r.x, 1.0 - (r.y + r.h), r.w, r.h);
    match o {
        Orientation::NoTransforms => r,
        Orientation::Rotate90 => rot90(r),
        Orientation::Rotate180 => rot180(r),
        Orientation::Rotate270 => rot270(r),
        Orientation::FlipHorizontal => fliph(r),
        Orientation::FlipVertical => flipv(r),
        Orientation::Rotate90FlipH => fliph(rot90(r)),
        Orientation::Rotate270FlipH => fliph(rot270(r)),
    }
}

fn swaps_axes(o: Orientation) -> bool {
    matches!(
        o,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    )
}

fn downscale(img: &DynamicImage, max_side: u32) -> DynamicImage {
    if img.width().max(img.height()) <= max_side {
        img.clone()
    } else {
        img.resize(max_side, max_side, FilterType::Triangle)
    }
}

/// `document`: el cliente declaró que es un documento (DNI, boleta…), aunque el fondo
/// no sea claro (un DNI azul): un clonado de texto ahí nunca es concluyente.
pub fn analyze_image(bytes: &[u8], document: bool) -> Result<ImageAnalysis, ImageError> {
    let (img, orientation, format) = decode(bytes)?;
    let (raw_w, raw_h) = (img.width(), img.height());
    let (width, height) = if swaps_axes(orientation) {
        (raw_h, raw_w)
    } else {
        (raw_w, raw_h)
    };
    let mut findings = Vec::new();

    let small = downscale(&img, QUALITY_MAX_SIDE);
    let gray_small = small.to_luma8();
    let megapixels = f64::from(raw_w) * f64::from(raw_h) / 1e6;
    let quality = quality::measure(&gray_small, megapixels);
    findings.extend(quality::findings(&quality, width, height));

    let mut thumb = downscale(&small, 256);
    thumb.apply_orientation(orientation);
    let dhash = dhash::to_hex(dhash::dhash(&thumb));

    let is_jpeg = format == ImageFormat::Jpeg;
    let ela = if u64::from(raw_w) * u64::from(raw_h) <= ELA_MAX_PIXELS {
        let rgb = img.to_rgb8();
        let result = ela::analyze(&rgb, ela::RECOMPRESS_QUALITY);
        findings.extend(
            result
                .regions
                .iter()
                .map(|r| ela::finding(r, &result.summary, is_jpeg, orientation, raw_w, raw_h)),
        );
        Some(result.summary)
    } else {
        findings.push(Finding::new(
            "ela.skipped",
            Layer::Forensics,
            Severity::Info,
            1.0,
            "La imagen es demasiado grande para el análisis de nivel de error (ELA).",
        ));
        None
    };

    for mut m in copy_move::detect(&img.to_luma8()) {
        m.document |= document;
        findings.push(copy_move::finding(&m, orientation, raw_w, raw_h));
    }

    let exif = exif::read(bytes);
    if let Some(info) = &exif {
        findings.extend(exif::findings(info));
    }

    if format != ImageFormat::Jpeg && exif.is_none() {
        findings.push(
            Finding::new(
                "image.no_camera_metadata",
                Layer::Forensics,
                Severity::Info,
                0.3,
                "La imagen no es JPEG ni trae metadatos de cámara: podría ser una captura de pantalla o una exportación.",
            )
            .with_evidence(json!({ "format": format!("{format:?}").to_lowercase() })),
        );
    }

    Ok(ImageAnalysis {
        report: ImageReport {
            width,
            height,
            dhash,
            quality,
            ela,
            exif,
        },
        findings,
        format,
    })
}

#[cfg(test)]
pub(crate) mod testutil {
    use ::image::codecs::jpeg::JpegEncoder;
    use ::image::{DynamicImage, GrayImage, ImageFormat, Luma, Rgb, RgbImage};

    /// Generador congruencial lineal: imágenes reproducibles sin dependencias.
    pub struct Lcg(pub u64);

    impl Lcg {
        pub fn next(&mut self) -> u32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 33) as u32
        }
    }

    /// Textura "documento": gradiente suave + ruido + trazos.
    pub fn textured_rgb(w: u32, h: u32, seed: u64) -> RgbImage {
        let mut rng = Lcg(seed);
        RgbImage::from_fn(w, h, |x, y| {
            let base = 120.0 + 60.0 * ((x as f64 / 37.0).sin() + (y as f64 / 23.0).cos());
            let n = (rng.next() % 60) as f64 - 30.0;
            let v = (base + n).clamp(0.0, 255.0) as u8;
            Rgb([v, v.saturating_add(10), v.saturating_sub(10)])
        })
    }

    pub fn noise_gray(w: u32, h: u32, seed: u64) -> GrayImage {
        let mut rng = Lcg(seed);
        GrayImage::from_fn(w, h, |_, _| Luma([(rng.next() % 256) as u8]))
    }

    pub fn encode_jpeg(img: &RgbImage, q: u8) -> Vec<u8> {
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, q)
            .encode_image(img)
            .unwrap();
        out
    }

    pub fn encode_png(img: &DynamicImage) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    pub fn decode_rgb(bytes: &[u8]) -> RgbImage {
        ::image::load_from_memory(bytes).unwrap().to_rgb8()
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    #[test]
    fn analyzes_jpeg() {
        let img = textured_rgb(640, 480, 1);
        let a = analyze_image(&encode_jpeg(&img, 90), false).unwrap();
        assert_eq!((a.report.width, a.report.height), (640, 480));
        assert_eq!(a.report.dhash.len(), 16);
        assert!(a.report.ela.is_some());
        assert!(a.report.exif.is_none());
        assert_eq!(a.format, ImageFormat::Jpeg);
        assert!((a.report.quality.megapixels - 0.3072).abs() < 1e-9);
    }

    #[test]
    fn analyzes_png() {
        let img = DynamicImage::ImageRgb8(textured_rgb(320, 240, 2));
        let a = analyze_image(&encode_png(&img), false).unwrap();
        assert_eq!(a.format, ImageFormat::Png);
        let codes: Vec<_> = a.findings.iter().map(|f| f.code.as_str()).collect();
        assert!(codes.contains(&"image.low_resolution"));
        assert!(codes.contains(&"image.no_camera_metadata"));
    }

    #[test]
    fn rejects_garbage() {
        assert!(analyze_image(b"not an image at all", false).is_err());
        assert!(analyze_image(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0], false).is_err());
    }

    #[test]
    fn region_orientation() {
        let r = Region::new(1, 0.1, 0.2, 0.3, 0.4);
        let r90 = orient_region(r, Orientation::Rotate90);
        assert!((r90.x - 0.4).abs() < 1e-9 && (r90.y - 0.1).abs() < 1e-9);
        assert!((r90.w - 0.4).abs() < 1e-9 && (r90.h - 0.3).abs() < 1e-9);
        let r180 = orient_region(r, Orientation::Rotate180);
        assert!((r180.x - 0.6).abs() < 1e-9 && (r180.y - 0.4).abs() < 1e-9);
        let r270 = orient_region(r, Orientation::Rotate270);
        assert!((r270.x - 0.2).abs() < 1e-9 && (r270.y - 0.6).abs() < 1e-9);
        assert_eq!(orient_region(r, Orientation::NoTransforms), r);
    }
}
