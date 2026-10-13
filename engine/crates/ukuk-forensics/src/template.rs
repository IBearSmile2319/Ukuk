//! Comparación contra la plantilla del emisor: cada ancla (texto fijo del
//! formato, p. ej. "RUC") debe aparecer cerca de su posición esperada.

use serde::{Deserialize, Serialize};
use serde_json::json;
use ukuk_core::{BBox, Finding, Layer, OcrWord, Region, Severity};
use ukuk_peru::text::fold;

use crate::layout::{group_lines, median};

pub const DEFAULT_TOLERANCE: f64 = 0.03;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Anchor {
    pub text: String,
    pub bbox: BBox,
    #[serde(default)]
    pub page: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Template {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub anchors: Vec<Anchor>,
    #[serde(default)]
    pub tolerance: Option<f64>,
}

fn compact(s: &str) -> String {
    fold(s).replace(' ', "")
}

/// Candidatos (página, bbox, calidad) para un ancla: 2 = igual, 1 = contenido.
fn candidates(anchor: &Anchor, words: &[OcrWord]) -> Vec<(u32, BBox, u8)> {
    let target = compact(&anchor.text);
    if target.is_empty() {
        return Vec::new();
    }
    let n_tokens = fold(&anchor.text).split(' ').count();
    let mut pages: Vec<u32> = words.iter().map(|w| w.page).collect();
    pages.sort_unstable();
    pages.dedup();
    if let Some(p) = anchor.page {
        pages.retain(|x| *x == p);
    }
    let mut out = Vec::new();
    for page in pages {
        for line in group_lines(words, page) {
            for start in 0..line.len() {
                // Ventanas de 1..=n_tokens+1 palabras (el OCR puede partir o unir tokens).
                let mut text = String::new();
                let mut bbox: Option<BBox> = None;
                for m in line.iter().skip(start).take(n_tokens + 1) {
                    text.push_str(&compact(&words[m.idx].text));
                    bbox = Some(bbox.map_or(m.bbox, |b| b.union(&m.bbox)));
                    let b = bbox.unwrap_or(m.bbox);
                    if text == target {
                        out.push((page, b, 2));
                        break;
                    }
                    if text.len() >= 3
                        && target.len() >= 3
                        && (text.contains(&target)
                            || (target.contains(&text) && text.len() * 4 >= target.len() * 3))
                    {
                        out.push((page, b, 1));
                    }
                    if text.len() > target.len() + 4 {
                        break;
                    }
                }
            }
        }
    }
    let best_quality = out.iter().map(|c| c.2).max().unwrap_or(0);
    out.retain(|c| c.2 == best_quality);
    out
}

fn dist(a: (f64, f64), b: (f64, f64)) -> f64 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

fn round(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

pub fn compare_template(template: Option<&Template>, words: &[OcrWord]) -> Vec<Finding> {
    let Some(t) = template else {
        return vec![Finding::new(
            "template.none",
            Layer::Template,
            Severity::Info,
            1.0,
            "Sin plantilla de referencia: confianza limitada",
        )];
    };
    if t.anchors.is_empty() || words.is_empty() {
        return vec![
            Finding::new(
                "template.not_evaluated",
                Layer::Template,
                Severity::Info,
                1.0,
                "No se pudo comparar con la plantilla: faltan anclas o palabras OCR.",
            )
            .with_evidence(json!({ "template_id": t.id, "anchors": t.anchors.len(), "ocr_words": words.len() })),
        ];
    }
    let tol = t
        .tolerance
        .filter(|v| *v > 0.0)
        .unwrap_or(DEFAULT_TOLERANCE);

    // Mejor coincidencia por ancla (la más cercana a la posición esperada).
    let matched: Vec<Option<(u32, BBox, (f64, f64))>> = t
        .anchors
        .iter()
        .map(|a| {
            let expected = a.bbox.center();
            candidates(a, words)
                .into_iter()
                .map(|(p, b, _)| {
                    let c = b.center();
                    (p, b, (c.0 - expected.0, c.1 - expected.1))
                })
                .min_by(|x, y| dist(x.2, (0.0, 0.0)).total_cmp(&dist(y.2, (0.0, 0.0))))
        })
        .collect();

    // Con 3+ anclas se descuenta el desplazamiento global (encuadre de la foto).
    let found: Vec<(f64, f64)> = matched.iter().flatten().map(|m| m.2).collect();
    let global = if found.len() >= 3 {
        (
            median(&mut found.iter().map(|d| d.0).collect::<Vec<_>>()),
            median(&mut found.iter().map(|d| d.1).collect::<Vec<_>>()),
        )
    } else {
        (0.0, 0.0)
    };

    let mut out = Vec::new();
    let mut missing = 0;
    for (anchor, m) in t.anchors.iter().zip(&matched) {
        match m {
            None => {
                missing += 1;
                out.push(
                    Finding::new(
                        "template.anchor_missing",
                        Layer::Template,
                        Severity::Medium,
                        0.6,
                        format!(
                            "No se encontró el texto «{}» que la plantilla espera.",
                            anchor.text
                        ),
                    )
                    .with_region(Region::from_bbox(anchor.page.unwrap_or(1), &anchor.bbox))
                    .with_evidence(json!({ "anchor": anchor.text, "expected": anchor.bbox })),
                );
            }
            Some((page, bbox, d)) => {
                let residual = dist((d.0 - global.0, d.1 - global.1), (0.0, 0.0));
                if residual > tol {
                    out.push(
                        Finding::new(
                            "template.anchor_displaced",
                            Layer::Template,
                            Severity::Medium,
                            (0.5 + (residual / tol - 1.0) * 0.1).min(0.8),
                            format!(
                                "El texto «{}» está desplazado respecto de la plantilla.",
                                anchor.text
                            ),
                        )
                        .with_region(Region::from_bbox(*page, bbox))
                        .with_evidence(json!({
                            "anchor": anchor.text,
                            "expected": anchor.bbox,
                            "found": bbox,
                            "displacement": round(residual),
                            "global_shift": [round(global.0), round(global.1)],
                            "tolerance": tol,
                        })),
                    );
                }
            }
        }
    }
    if t.anchors.len() >= 2 && missing * 2 >= t.anchors.len() {
        out.push(
            Finding::new(
                "template.mismatch",
                Layer::Template,
                Severity::Medium,
                0.6,
                format!(
                    "El documento no coincide con la plantilla «{}»: faltan {missing} de {} anclas.",
                    t.label.as_deref().unwrap_or("sin nombre"),
                    t.anchors.len()
                ),
            )
            .with_evidence(json!({ "template_id": t.id, "missing": missing, "anchors": t.anchors.len() })),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::tests::{receipt, word};

    fn anchor(text: &str, words: &[OcrWord]) -> Anchor {
        let parts: Vec<String> = fold(text).split(' ').map(str::to_string).collect();
        let first = words
            .iter()
            .position(|w| compact(&w.text) == parts[0])
            .unwrap();
        let mut b = words[first].bbox;
        for (k, _) in parts.iter().enumerate().skip(1) {
            b = b.union(&words[first + k].bbox);
        }
        Anchor {
            text: text.into(),
            bbox: b,
            page: None,
        }
    }

    fn template(words: &[OcrWord]) -> Template {
        Template {
            id: Some("t1".into()),
            label: Some("Clínica formato 1".into()),
            anchors: vec![
                anchor("RUC", words),
                anchor("TOTAL A PAGAR", words),
                anchor("Fecha de emisión", words),
            ],
            tolerance: Some(0.03),
        }
    }

    fn codes(f: &[Finding]) -> Vec<&str> {
        f.iter().map(|f| f.code.as_str()).collect()
    }

    #[test]
    fn no_template() {
        let f = compare_template(None, &[]);
        assert_eq!(f[0].code, "template.none");
        assert_eq!(
            f[0].message,
            "Sin plantilla de referencia: confianza limitada"
        );
    }

    #[test]
    fn matching_template() {
        let words = receipt();
        assert!(compare_template(Some(&template(&words)), &words).is_empty());
    }

    #[test]
    fn global_shift_is_tolerated() {
        let words = receipt();
        let t = template(&words);
        let shifted: Vec<OcrWord> = words
            .iter()
            .map(|w| {
                let mut w = w.clone();
                w.bbox.x += 0.1;
                w.bbox.y += 0.05;
                w
            })
            .collect();
        assert!(compare_template(Some(&t), &shifted).is_empty());
    }

    #[test]
    fn displaced_anchor() {
        let words = receipt();
        let t = template(&words);
        let mut moved = words.clone();
        for w in moved.iter_mut().filter(|w| w.text == "RUC") {
            w.bbox.x += 0.2;
        }
        let f = compare_template(Some(&t), &moved);
        assert_eq!(codes(&f), vec!["template.anchor_displaced"]);
        assert!(
            f[0].evidence.as_ref().unwrap()["displacement"]
                .as_f64()
                .unwrap()
                > 0.1
        );
    }

    #[test]
    fn missing_anchors() {
        let words = receipt();
        let t = template(&words);
        let fewer: Vec<OcrWord> = words
            .into_iter()
            .filter(|w| w.text != "RUC" && w.text != "TOTAL")
            .collect();
        let f = compare_template(Some(&t), &fewer);
        assert!(codes(&f).contains(&"template.anchor_missing"));
        assert!(codes(&f).contains(&"template.mismatch"));
    }

    #[test]
    fn ocr_split_and_accents() {
        let words = vec![word("Emisión:", 0.1, 0.1, 0.05, 0.01)];
        let t = Template {
            id: None,
            label: None,
            anchors: vec![Anchor {
                text: "EMISION".into(),
                bbox: BBox {
                    x: 0.1,
                    y: 0.1,
                    w: 0.05,
                    h: 0.01,
                },
                page: None,
            }],
            tolerance: None,
        };
        assert!(compare_template(Some(&t), &words).is_empty());
        assert_eq!(
            codes(&compare_template(Some(&t), &[])),
            vec!["template.not_evaluated"]
        );
    }
}
