//! Texto alterado: palabras cuyo trazo, tinta, nitidez o fondo no se parecen a ninguna otra
//! del documento. Un nombre reescrito sobre un parche suele traer otra fuente, otro grosor y un
//! fondo liso donde antes había trama o microtexto.
//!
//! Cada palabra se compara con sus vecinas más parecidas (k vecinos), no con el promedio: en un
//! acta las etiquetas y los datos tienen estilos distintos, y eso es legítimo. Lo sospechoso es
//! la palabra que no se parece a ninguna.

use ::image::GrayImage;
use serde_json::json;
use ukuk_core::{Finding, Layer, OcrWord, Region, Severity};

/// Altura mínima de una palabra en píxeles para medir su trazo.
const MIN_PX_HEIGHT: u32 = 10;
const K: usize = 4;
/// Con menos palabras medibles no hay con qué comparar.
const MIN_WORDS: usize = 12;
/// Distancia al k-ésimo vecino dividida por la mediana de esas distancias en el documento.
pub const DEFAULT_OUTLIER: f64 = 3.0;
/// Fondo lejano con N veces más trama que el pegado a la palabra.
pub const DEFAULT_PATCH: f64 = 4.0;
const MAX_FINDINGS: usize = 5;
const MAD_FLOOR: f64 = 1e-3;

const FEATURES: [&str; 5] = [
    "tono de la tinta",
    "grosor del trazo",
    "nitidez de los bordes",
    "textura del fondo",
    "brillo del fondo",
];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WordMarks {
    /// [tinta, trazo/alto, nitidez, textura del fondo, brillo del fondo]
    pub f: [f64; 5],
    pub height_px: f64,
    /// Textura del fondo lejano / textura del fondo pegado a la palabra. Un parche liso sobre
    /// una trama de seguridad da un valor alto.
    pub patch: f64,
}

/// Textura fina (diferencia media entre píxeles claros vecinos) en `outer` sin `inner`.
fn ring_texture(
    img: &GrayImage,
    t: u8,
    outer: (u32, u32, u32, u32),
    inner: (u32, u32, u32, u32),
) -> Option<f64> {
    let (mut n, mut sum) = (0u32, 0.0);
    for y in outer.1..outer.3 {
        for x in outer.0.max(1)..outer.2 {
            if (inner.0..inner.2).contains(&x) && (inner.1..inner.3).contains(&y) {
                continue;
            }
            let (a, b) = (img.get_pixel(x - 1, y).0[0], img.get_pixel(x, y).0[0]);
            if a > t && b > t {
                n += 1;
                sum += (f64::from(a) - f64::from(b)).abs();
            }
        }
    }
    (n >= 40).then(|| sum / f64::from(n))
}

fn expand(img: &GrayImage, b: (u32, u32, u32, u32), m: u32) -> (u32, u32, u32, u32) {
    (
        b.0.saturating_sub(m),
        b.1.saturating_sub(m),
        (b.2 + m).min(img.width()),
        (b.3 + m).min(img.height()),
    )
}

/// Umbral de Otsu sobre un histograma de 256 niveles.
fn otsu(hist: &[u32; 256]) -> u8 {
    let total: f64 = hist.iter().map(|&c| f64::from(c)).sum();
    let sum: f64 = hist
        .iter()
        .enumerate()
        .map(|(i, &c)| i as f64 * f64::from(c))
        .sum();
    let (mut w_b, mut sum_b, mut best, mut t) = (0.0, 0.0, -1.0, 0u8);
    for (i, &c) in hist.iter().enumerate() {
        w_b += f64::from(c);
        if w_b == 0.0 {
            continue;
        }
        let w_f = total - w_b;
        if w_f == 0.0 {
            break;
        }
        sum_b += i as f64 * f64::from(c);
        let (m_b, m_f) = (sum_b / w_b, (sum - sum_b) / w_f);
        let between = w_b * w_f * (m_b - m_f).powi(2);
        if between > best {
            best = between;
            t = i as u8;
        }
    }
    t
}

fn pixel_box(img: &GrayImage, w: &OcrWord) -> Option<(u32, u32, u32, u32)> {
    let (iw, ih) = (f64::from(img.width()), f64::from(img.height()));
    let x0 = (w.bbox.x * iw).floor().max(0.0) as u32;
    let y0 = (w.bbox.y * ih).floor().max(0.0) as u32;
    let x1 = ((w.bbox.x + w.bbox.w) * iw).ceil().min(iw) as u32;
    let y1 = ((w.bbox.y + w.bbox.h) * ih).ceil().min(ih) as u32;
    (y1 > y0 + MIN_PX_HEIGHT && x1 > x0 + (y1 - y0) / 2).then_some((x0, y0, x1, y1))
}

/// Mide una palabra: tinta, grosor del trazo, nitidez y el fondo que la rodea.
pub fn measure(img: &GrayImage, w: &OcrWord) -> Option<WordMarks> {
    let (x0, y0, x1, y1) = pixel_box(img, w)?;
    let mut hist = [0u32; 256];
    for y in y0..y1 {
        for x in x0..x1 {
            hist[img.get_pixel(x, y).0[0] as usize] += 1;
        }
    }
    let t = otsu(&hist);
    let ink = |x: u32, y: u32| img.get_pixel(x, y).0[0] <= t;
    let (mut n_ink, mut n_bg, mut ink_sum, mut bg_sum, mut perimeter, mut grad) =
        (0u32, 0u32, 0.0, 0.0, 0u32, 0.0);
    for y in y0..y1 {
        for x in x0..x1 {
            let v = f64::from(img.get_pixel(x, y).0[0]);
            if !ink(x, y) {
                n_bg += 1;
                bg_sum += v;
                continue;
            }
            n_ink += 1;
            ink_sum += v;
            let edge = (x > x0 && !ink(x - 1, y))
                || (x + 1 < x1 && !ink(x + 1, y))
                || (y > y0 && !ink(x, y - 1))
                || (y + 1 < y1 && !ink(x, y + 1));
            if edge {
                perimeter += 1;
                let g = |a: u32, b: u32| f64::from(img.get_pixel(a, b).0[0]);
                let gx = g((x + 1).min(x1 - 1), y) - g(x.saturating_sub(1).max(x0), y);
                let gy = g(x, (y + 1).min(y1 - 1)) - g(x, y.saturating_sub(1).max(y0));
                grad += (gx * gx + gy * gy).sqrt();
            }
        }
    }
    let area = f64::from((x1 - x0) * (y1 - y0));
    if n_ink < 20 || perimeter == 0 || n_bg == 0 || f64::from(n_ink) > 0.7 * area {
        return None;
    }
    let (ink_mean, bg_mean) = (ink_sum / f64::from(n_ink), bg_sum / f64::from(n_bg));
    let h = f64::from(y1 - y0);
    let stroke = 2.0 * f64::from(n_ink) / f64::from(perimeter) / h;
    let sharp = grad / f64::from(perimeter) / (bg_mean - ink_mean).max(8.0);

    // Fondo alrededor: un anillo de media altura, solo píxeles claros (sin tinta vecina).
    let m = (y1 - y0) / 2;
    let (rx0, ry0) = (x0.saturating_sub(m), y0.saturating_sub(m));
    let (rx1, ry1) = ((x1 + m).min(img.width()), (y1 + m).min(img.height()));
    let (mut n, mut s, mut s2) = (0u32, 0.0, 0.0);
    for y in ry0..ry1 {
        for x in rx0..rx1 {
            if (x0..x1).contains(&x) && (y0..y1).contains(&y) {
                continue;
            }
            let v = img.get_pixel(x, y).0[0];
            if v > t {
                let v = f64::from(v);
                n += 1;
                s += v;
                s2 += v * v;
            }
        }
    }
    if n < 20 {
        return None;
    }
    let ring_mean = s / f64::from(n);
    let ring_std = (s2 / f64::from(n) - ring_mean * ring_mean).max(0.0).sqrt();
    let word = (x0, y0, x1, y1);
    let near = ring_texture(img, t, expand(img, word, m / 2), word);
    let far = ring_texture(img, t, expand(img, word, 2 * m), expand(img, word, m));
    let patch = match (near, far) {
        (Some(a), Some(b)) => b / a.max(0.3),
        _ => 1.0,
    };
    Some(WordMarks {
        patch,
        f: [
            ink_mean / 255.0,
            stroke,
            sharp,
            ring_std / 255.0,
            ring_mean / 255.0,
        ],
        height_px: h,
    })
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(f64::total_cmp);
    let n = v.len();
    if n == 0 {
        0.0
    } else if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

/// `threshold`: cuánto más lejos de sus vecinas está la palabra que una palabra típica.
pub fn analyze_text_marks(
    img: &GrayImage,
    words: &[OcrWord],
    threshold: f64,
    patch_threshold: f64,
) -> Vec<Finding> {
    let measured: Vec<(usize, WordMarks)> = words
        .iter()
        .enumerate()
        .filter(|(_, w)| w.page == 1 && w.text.chars().filter(|c| c.is_alphanumeric()).count() >= 3)
        .filter_map(|(i, w)| measure(img, w).map(|m| (i, m)))
        .collect();
    let mut patches: Vec<&(usize, WordMarks)> = measured
        .iter()
        .filter(|(_, m)| m.patch > patch_threshold)
        .collect();
    patches.sort_by(|a, b| b.1.patch.total_cmp(&a.1.patch));
    let mut out: Vec<Finding> = patches
        .into_iter()
        .take(MAX_FINDINGS)
        .map(|(idx, m)| {
            let w = &words[*idx];
            Finding::new(
                "text.flat_background",
                Layer::Forensics,
                Severity::Medium,
                (0.3 + 0.05 * m.patch).min(0.7),
                format!("Alrededor de «{}» el fondo es liso pero más lejos tiene trama: posible parche con texto reescrito.", w.text),
            )
            .with_region(Region::from_bbox(1, &w.bbox))
            .with_evidence(json!({ "text": w.text, "patch": (m.patch * 100.0).round() / 100.0 }))
        })
        .collect();
    if measured.len() < MIN_WORDS {
        return out;
    }
    // Estandarización robusta de cada rasgo; la altura entra para comparar palabras de tamaño parecido.
    let dims = FEATURES.len();
    let mut center = [0.0; 5];
    let mut scale = [0.0; 5];
    for d in 0..dims {
        let mut v: Vec<f64> = measured.iter().map(|(_, m)| m.f[d]).collect();
        center[d] = median(&mut v);
        let mut dev: Vec<f64> = measured
            .iter()
            .map(|(_, m)| (m.f[d] - center[d]).abs())
            .collect();
        scale[d] = (median(&mut dev) * 1.4826).max(MAD_FLOOR);
    }
    let z = |m: &WordMarks| -> [f64; 6] {
        let mut out = [0.0; 6];
        for d in 0..dims {
            out[d] = (m.f[d] - center[d]) / scale[d];
        }
        out[5] = m.height_px.ln() * 3.0;
        out
    };
    let vecs: Vec<[f64; 6]> = measured.iter().map(|(_, m)| z(m)).collect();
    let kth: Vec<f64> = vecs
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let mut d: Vec<f64> = vecs
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, b)| {
                    a.iter()
                        .zip(b)
                        .map(|(x, y)| (x - y).powi(2))
                        .sum::<f64>()
                        .sqrt()
                })
                .collect();
            d.sort_by(f64::total_cmp);
            d[K.min(d.len()) - 1]
        })
        .collect();
    let typical = median(&mut kth.clone()).max(1e-6);

    let mut flagged: Vec<(f64, usize)> = kth
        .iter()
        .enumerate()
        .map(|(i, d)| (d / typical, i))
        .filter(|(s, _)| *s > threshold)
        .collect();
    flagged.sort_by(|a, b| b.0.total_cmp(&a.0));
    out.extend(flagged
        .into_iter()
        .take(MAX_FINDINGS)
        .map(|(score, i)| {
            let (idx, m) = measured[i];
            let w = &words[idx];
            let mut why: Vec<(f64, &str)> = (0..dims).map(|d| (vecs[i][d].abs(), FEATURES[d])).collect();
            why.sort_by(|a, b| b.0.total_cmp(&a.0));
            let reasons: Vec<&str> = why.iter().take(2).map(|(_, n)| *n).collect();
            Finding::new(
                "text.inconsistent_word",
                Layer::Forensics,
                Severity::Medium,
                (0.35 + 0.05 * score).min(0.75),
                format!(
                    "La palabra «{}» no se parece a ninguna otra del documento ({}): posible texto reescrito o pegado.",
                    w.text,
                    reasons.join(" y ")
                ),
            )
            .with_region(Region::from_bbox(1, &w.bbox))
            .with_evidence(json!({
                "text": w.text,
                "score": (score * 100.0).round() / 100.0,
                "differs_in": reasons,
                "features": {
                    "ink": m.f[0], "stroke": m.f[1], "sharpness": m.f[2], "bg_texture": m.f[3], "bg_luma": m.f[4]
                },
                "words_compared": measured.len(),
            }))
        })
        .collect::<Vec<_>>());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::testutil::Lcg;
    use ::image::Luma;
    use ukuk_core::BBox;

    /// Página con trama de seguridad (ruido) y «palabras» de barras verticales.
    fn page(forged: Option<usize>) -> (GrayImage, Vec<OcrWord>) {
        let (w, h) = (1200u32, 1600u32);
        let mut rng = Lcg(42);
        let mut img = GrayImage::from_fn(w, h, |_, _| Luma([200 + (rng.next() % 40) as u8]));
        let mut words = Vec::new();
        for i in 0..40usize {
            let (bx, by) = (80 + (i % 4) as u32 * 270, 100 + (i / 4) as u32 * 140);
            let (bw, bh) = (200u32, 30u32);
            let fake = forged == Some(i);
            if fake {
                // Parche liso: sin trama, como un nombre reescrito encima.
                for y in by.saturating_sub(15)..by + bh + 15 {
                    for x in bx.saturating_sub(15)..bx + bw + 15 {
                        img.put_pixel(x, y, Luma([238]));
                    }
                }
            }
            let (stroke, ink) = if fake { (2u32, 0u8) } else { (5u32, 40u8) };
            for k in 0..12u32 {
                for y in by..by + bh {
                    for x in bx + k * 16..bx + k * 16 + stroke {
                        img.put_pixel(x, y, Luma([ink]));
                    }
                }
            }
            words.push(OcrWord {
                text: format!("DATO{i}"),
                confidence: 0.9,
                page: 1,
                bbox: BBox {
                    x: f64::from(bx) / f64::from(w),
                    y: f64::from(by) / f64::from(h),
                    w: f64::from(bw) / f64::from(w),
                    h: f64::from(bh) / f64::from(h),
                },
            });
        }
        (img, words)
    }

    #[test]
    fn otsu_splits_ink_from_paper() {
        let mut hist = [0u32; 256];
        hist[30] = 100;
        hist[220] = 900;
        let t = otsu(&hist);
        assert!((30..220).contains(&t), "{t}");
    }

    #[test]
    fn rewritten_word_on_a_patch_stands_out() {
        let (img, words) = page(Some(17));
        let f = analyze_text_marks(&img, &words, DEFAULT_OUTLIER, DEFAULT_PATCH);
        assert_eq!(
            f.first()
                .map(|f| f.evidence.as_ref().unwrap()["text"].as_str().unwrap()),
            Some("DATO17"),
            "{f:?}"
        );
    }

    #[test]
    fn uniform_document_has_no_findings() {
        let (img, words) = page(None);
        assert!(analyze_text_marks(&img, &words, DEFAULT_OUTLIER, DEFAULT_PATCH).is_empty());
    }

    #[test]
    fn too_few_words_are_not_judged() {
        let (img, words) = page(Some(3));
        assert!(analyze_text_marks(&img, &words[..8], DEFAULT_OUTLIER, f64::INFINITY).is_empty());
    }
}
