//! Consistencia de disposición del texto OCR: palabras fuera de la línea base
//! o con tamaño de letra atípico (típico de montos o nombres reemplazados).

use serde_json::json;
use ukuk_core::{BBox, Finding, Layer, OcrWord, Region, Severity};

/// Desviación de línea base tolerada, como fracción de la altura de letra.
pub const BASELINE_TOLERANCE: f64 = 0.25;
/// Umbral de z robusto (MAD) para tamaño de letra atípico.
pub const ROBUST_Z: f64 = 3.5;
const MAD_FLOOR: f64 = 0.04;
const MIN_LINE_WORDS: usize = 3;
/// Solapamiento vertical mínimo (fracción de la menor altura) para unir a una línea.
const LINE_OVERLAP: f64 = 0.3;
const MAX_FINDINGS_PER_CODE: usize = 10;
/// Diferencia de tamaño que se tolera en palabras sin dígitos: una tilde sobre una
/// mayúscula (CLÍNICA) o una caja de OCR algo holgada ya mueven la medida ~25 %.
const TEXT_SIZE_TOLERANCE: f64 = 0.3;
const DIGIT_SIZE_TOLERANCE: f64 = 0.15;

/// Lo que se adultera son montos, fechas y números de documento: una anomalía en una
/// palabra con dígitos pesa más que en una etiqueta, donde el ruido del OCR domina.
fn weigh(text: &str, confidence: f64) -> (Severity, f64) {
    if text.chars().any(|c| c.is_ascii_digit()) {
        (Severity::Medium, confidence)
    } else {
        (Severity::Low, confidence.min(0.4))
    }
}

// Proporciones tipográficas aproximadas respecto del cuerpo de la letra.
const X_HEIGHT: f64 = 0.5;
const ASCENDER: f64 = 0.72;
const DESCENDER: f64 = 0.22;

/// Perfil vertical de una palabra según sus caracteres: (alto superior, descendente).
fn glyph_profile(text: &str) -> Option<(f64, f64)> {
    let mut alnum = false;
    let mut tall = false;
    let mut desc = false;
    for c in text.chars() {
        if c.is_alphanumeric() {
            alnum = true;
        }
        if c.is_uppercase()
            || c.is_ascii_digit()
            || "bdfhklt".contains(c)
            || "áéíóúÁÉÍÓÚñÑ".contains(c)
        {
            tall = true;
        }
        if "gjpqy".contains(c) {
            desc = true;
        }
        if matches!(c, ',' | ';' | '(' | ')') {
            desc = true;
            tall = true;
        }
    }
    alnum.then_some((
        if tall { ASCENDER } else { X_HEIGHT },
        if desc { DESCENDER } else { 0.0 },
    ))
}

#[derive(Debug, Clone)]
pub(crate) struct Measured {
    pub idx: usize,
    pub bbox: BBox,
    /// Tamaño de letra estimado (cuerpo), normalizado.
    pub size: f64,
    /// Línea base estimada (descontando descendentes).
    pub baseline: f64,
    pub alnum_chars: usize,
}

fn measure(idx: usize, w: &OcrWord) -> Option<Measured> {
    let b = w.bbox;
    if b.h <= 0.0 || b.w <= 0.0 || !b.h.is_finite() {
        return None;
    }
    let (top, desc) = glyph_profile(&w.text)?;
    let size = b.h / (top + desc);
    Some(Measured {
        idx,
        bbox: b,
        size,
        baseline: b.bottom() - desc * size,
        alnum_chars: w.text.chars().filter(|c| c.is_alphanumeric()).count(),
    })
}

/// Agrupa palabras de una página en líneas por solapamiento vertical.
pub(crate) fn group_lines(words: &[OcrWord], page: u32) -> Vec<Vec<Measured>> {
    let mut items: Vec<Measured> = words
        .iter()
        .enumerate()
        .filter(|(_, w)| w.page == page)
        .filter_map(|(i, w)| measure(i, w))
        .collect();
    items.sort_by(|a, b| a.bbox.center().1.total_cmp(&b.bbox.center().1));
    let mut lines: Vec<(f64, f64, Vec<Measured>)> = Vec::new();
    for m in items {
        let (top, bottom) = (m.bbox.y, m.bbox.bottom());
        let best = lines
            .iter_mut()
            .rev()
            .take(4)
            .map(|line| {
                let overlap = (bottom.min(line.1) - top.max(line.0)).max(0.0);
                let ratio = overlap / (bottom - top).min(line.1 - line.0).max(1e-9);
                (ratio, line)
            })
            .filter(|(r, _)| *r >= LINE_OVERLAP)
            .max_by(|a, b| a.0.total_cmp(&b.0));
        match best {
            Some((_, line)) => {
                let n = line.2.len() as f64;
                line.0 = (line.0 * n + top) / (n + 1.0);
                line.1 = (line.1 * n + bottom) / (n + 1.0);
                line.2.push(m);
            }
            None => lines.push((top, bottom, vec![m])),
        }
    }
    lines
        .into_iter()
        .map(|(_, _, mut ws)| {
            ws.sort_by(|a, b| a.bbox.x.total_cmp(&b.bbox.x));
            ws
        })
        .collect()
}

pub(crate) fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(f64::total_cmp);
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

fn round(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

pub fn analyze_layout(words: &[OcrWord]) -> Vec<Finding> {
    let mut pages: Vec<u32> = words.iter().map(|w| w.page).collect();
    pages.sort_unstable();
    pages.dedup();

    let mut misaligned: Vec<(f64, Finding)> = Vec::new();
    // (índice de palabra, página, bbox, tamaño relativo a su línea)
    let mut relative: Vec<(usize, u32, BBox, f64)> = Vec::new();

    for page in pages {
        for line in group_lines(words, page) {
            if line.len() < MIN_LINE_WORDS {
                continue;
            }
            let med_base = median(&mut line.iter().map(|m| m.baseline).collect::<Vec<_>>());
            let med_size = median(&mut line.iter().map(|m| m.size).collect::<Vec<_>>());
            if med_size <= 0.0 {
                continue;
            }
            for m in &line {
                let dev = (m.baseline - med_base).abs() / med_size;
                if dev > BASELINE_TOLERANCE {
                    let w = &words[m.idx];
                    let (severity, confidence) = weigh(&w.text, (0.45 + dev * 0.3).min(0.75));
                    misaligned.push((
                        dev,
                        Finding::new(
                            "layout.misaligned_text",
                            Layer::Forensics,
                            severity,
                            confidence,
                            format!("La palabra «{}» está desalineada respecto de su línea; podría haber sido insertada.", w.text),
                        )
                        .with_region(Region::from_bbox(page, &m.bbox))
                        .with_evidence(json!({
                            "text": w.text,
                            "baseline_deviation": round(dev),
                            "tolerance": BASELINE_TOLERANCE,
                        })),
                    ));
                }
                if m.alnum_chars >= 2 {
                    relative.push((m.idx, page, m.bbox, m.size / med_size));
                }
            }
        }
    }

    let mut sized: Vec<(f64, Finding)> = Vec::new();
    if relative.len() >= 8 {
        let med = median(&mut relative.iter().map(|r| r.3).collect::<Vec<_>>());
        let mad = median(
            &mut relative
                .iter()
                .map(|r| (r.3 - med).abs())
                .collect::<Vec<_>>(),
        )
        .max(MAD_FLOOR);
        for (idx, page, bbox, r) in &relative {
            let z = 0.6745 * (r - med) / mad;
            let w = &words[*idx];
            let tolerance = if w.text.chars().any(|c| c.is_ascii_digit()) {
                DIGIT_SIZE_TOLERANCE
            } else {
                TEXT_SIZE_TOLERANCE
            };
            if z.abs() > ROBUST_Z && (r - med).abs() > tolerance {
                let (severity, confidence) = weigh(&w.text, (0.4 + z.abs() * 0.03).min(0.7));
                sized.push((
                    z.abs(),
                    Finding::new(
                        "layout.font_size_outlier",
                        Layer::Forensics,
                        severity,
                        confidence,
                        format!("La palabra «{}» tiene un tamaño de letra distinto al resto de su línea.", w.text),
                    )
                    .with_region(Region::from_bbox(*page, bbox))
                    .with_evidence(json!({ "text": w.text, "relative_size": round(*r), "robust_z": round(z) })),
                ));
            }
        }
    }

    let mut out = Vec::new();
    for mut group in [misaligned, sized] {
        group.sort_by(|a, b| b.0.total_cmp(&a.0));
        out.extend(
            group
                .into_iter()
                .take(MAX_FINDINGS_PER_CODE)
                .map(|(_, f)| f),
        );
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn word(text: &str, x: f64, y: f64, w: f64, h: f64) -> OcrWord {
        OcrWord {
            text: text.into(),
            confidence: 0.99,
            page: 1,
            bbox: BBox { x, y, w, h },
        }
    }

    /// Recibo sintético: líneas con alturas coherentes según los glifos.
    pub(crate) fn receipt() -> Vec<OcrWord> {
        let mut words = Vec::new();
        let lines = [
            vec!["CLINICA", "SAN", "MARTIN", "SAC"],
            vec!["RUC", "20100047218", "Lima", "Peru"],
            vec!["Fecha", "de", "emision", "15/03/2026"],
            vec!["Consulta", "medica", "general", "100.00"],
            vec!["IGV", "18%", "monto", "18.00"],
            vec!["TOTAL", "A", "PAGAR", "118.00"],
        ];
        for (li, line) in lines.iter().enumerate() {
            let size = 0.02;
            let baseline = 0.1 + li as f64 * 0.05;
            let mut x = 0.1;
            for t in line {
                let (top, desc) = glyph_profile(t).unwrap();
                let h = size * (top + desc);
                let y = baseline + desc * size - h;
                let w = 0.012 * t.len() as f64;
                words.push(word(t, x, y, w, h));
                x += w + 0.01;
            }
        }
        words
    }

    fn codes(f: &[Finding]) -> Vec<&str> {
        f.iter().map(|f| f.code.as_str()).collect()
    }

    #[test]
    fn clean_layout_has_no_findings() {
        let f = analyze_layout(&receipt());
        assert!(f.is_empty(), "{f:?}");
    }

    #[test]
    fn detects_shifted_word() {
        let mut words = receipt();
        let i = words.iter().position(|w| w.text == "118.00").unwrap();
        words[i].bbox.y -= 0.008; // 40 % de la altura de letra
        let f = analyze_layout(&words);
        assert_eq!(codes(&f), vec!["layout.misaligned_text"]);
        assert!(f[0].message.contains("118.00"));
        assert!(f[0].region.is_some());
    }

    #[test]
    fn detects_font_size_outlier() {
        let mut words = receipt();
        let i = words.iter().position(|w| w.text == "100.00").unwrap();
        // Mismo renglón (misma línea base) pero 50 % más grande.
        let b = words[i].bbox;
        words[i].bbox = BBox {
            x: b.x,
            y: b.bottom() - b.h * 1.5,
            w: b.w * 1.5,
            h: b.h * 1.5,
        };
        let f = analyze_layout(&words);
        assert!(codes(&f).contains(&"layout.font_size_outlier"), "{f:?}");
        assert!(!codes(&f).contains(&"layout.misaligned_text"));
        assert_eq!(f[0].severity, Severity::Medium);
    }

    #[test]
    fn accented_capitals_and_dates_are_not_outliers() {
        let mut words = receipt();
        // CLÍNICA: la tilde agranda la caja ~26 % aunque el OCR devuelva "CLINICA".
        let i = words.iter().position(|w| w.text == "CLINICA").unwrap();
        let b = words[i].bbox;
        words[i].bbox = BBox {
            y: b.bottom() - b.h * 1.26,
            h: b.h * 1.26,
            ..b
        };
        assert!(analyze_layout(&words).is_empty());
    }

    #[test]
    fn label_noise_is_low_severity() {
        let mut words = receipt();
        let i = words.iter().position(|w| w.text == "Consulta").unwrap();
        let b = words[i].bbox;
        words[i].bbox = BBox {
            y: b.bottom() - b.h * 1.8,
            h: b.h * 1.8,
            ..b
        };
        let f = analyze_layout(&words);
        assert!(!f.is_empty());
        assert!(
            f.iter()
                .all(|f| f.severity == Severity::Low && f.confidence <= 0.4),
            "{f:?}"
        );
    }

    #[test]
    fn descenders_are_not_misalignment() {
        let words = vec![
            word("Pago", 0.1, 0.1, 0.05, 0.0188),
            word("TOTAL", 0.2, 0.1, 0.06, 0.0144),
            word("mes", 0.3, 0.1 + 0.0044, 0.04, 0.01),
            word("ABC", 0.4, 0.1, 0.04, 0.0144),
        ];
        assert!(analyze_layout(&words).is_empty());
    }

    #[test]
    fn ignores_degenerate_words() {
        let words = vec![
            word("", 0.1, 0.1, 0.0, 0.0),
            word("---", 0.2, 0.1, 0.1, 0.01),
        ];
        assert!(analyze_layout(&words).is_empty());
    }
}
