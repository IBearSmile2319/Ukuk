use serde::{Deserialize, Serialize};

/// Región normalizada (0..1) sobre una página o imagen. `page` empieza en 1.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Region {
    /// Construye una región recortando los valores al rango [0, 1].
    pub fn new(page: u32, x: f64, y: f64, w: f64, h: f64) -> Self {
        let x = x.clamp(0.0, 1.0);
        let y = y.clamp(0.0, 1.0);
        Self {
            page: page.max(1),
            x: round4(x),
            y: round4(y),
            w: round4(w.clamp(0.0, 1.0 - x)),
            h: round4(h.clamp(0.0, 1.0 - y)),
        }
    }

    /// Región a partir de un rectángulo en píxeles.
    pub fn from_pixels(page: u32, x: u32, y: u32, w: u32, h: u32, width: u32, height: u32) -> Self {
        let (fw, fh) = (f64::from(width.max(1)), f64::from(height.max(1)));
        Self::new(
            page,
            f64::from(x) / fw,
            f64::from(y) / fh,
            f64::from(w) / fw,
            f64::from(h) / fh,
        )
    }

    pub fn from_bbox(page: u32, b: &BBox) -> Self {
        Self::new(page, b.x, b.y, b.w, b.h)
    }
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

/// Caja delimitadora normalizada (0..1).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct BBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl BBox {
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }

    pub fn union(&self, other: &BBox) -> BBox {
        let x0 = self.x.min(other.x);
        let y0 = self.y.min(other.y);
        let x1 = (self.x + self.w).max(other.x + other.w);
        let y1 = (self.y + self.h).max(other.y + other.h);
        BBox {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        }
    }
}

/// Palabra reconocida por OCR (Textract u otro), con caja normalizada.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OcrWord {
    pub text: String,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    #[serde(default = "default_page")]
    pub page: u32,
    pub bbox: BBox,
}

fn default_confidence() -> f64 {
    1.0
}

fn default_page() -> u32 {
    1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Layer {
    Quality,
    Classification,
    Extraction,
    Consistency,
    Forensics,
    Template,
    External,
    Reuse,
}

/// Hallazgo individual. `code` sigue el formato `namespace.punto`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    pub code: String,
    pub layer: Layer,
    pub severity: Severity,
    pub confidence: f64,
    pub message: String,
    pub region: Option<Region>,
    pub evidence: Option<serde_json::Value>,
}

impl Finding {
    pub fn new(
        code: impl Into<String>,
        layer: Layer,
        severity: Severity,
        confidence: f64,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            layer,
            severity,
            confidence: round4(confidence.clamp(0.0, 1.0)),
            message: message.into(),
            region: None,
            evidence: None,
        }
    }

    pub fn with_region(mut self, region: Region) -> Self {
        self.region = Some(region);
        self
    }

    pub fn with_evidence(mut self, evidence: serde_json::Value) -> Self {
        self.evidence = Some(evidence);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_is_clamped_and_rounded() {
        let r = Region::new(0, -0.1, 0.5, 2.0, 0.123456);
        assert_eq!(r.page, 1);
        assert_eq!(r.x, 0.0);
        assert_eq!(r.w, 1.0);
        assert_eq!(r.h, 0.1235);
    }

    #[test]
    fn region_from_pixels() {
        let r = Region::from_pixels(1, 50, 25, 50, 25, 100, 100);
        assert_eq!((r.x, r.y, r.w, r.h), (0.5, 0.25, 0.5, 0.25));
    }

    #[test]
    fn finding_serializes_snake_case() {
        let f = Finding::new("image.blur", Layer::Quality, Severity::Medium, 0.8, "x");
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["layer"], "quality");
        assert_eq!(v["severity"], "medium");
        assert!(v["region"].is_null());
        assert!(v["evidence"].is_null());
    }

    #[test]
    fn severity_ordering() {
        assert!(Severity::Critical > Severity::High);
        assert!(Severity::Info < Severity::Low);
    }

    #[test]
    fn ocr_word_defaults() {
        let w: OcrWord =
            serde_json::from_str(r#"{"text":"A","bbox":{"x":0,"y":0,"w":0.1,"h":0.1}}"#).unwrap();
        assert_eq!(w.page, 1);
        assert_eq!(w.confidence, 1.0);
    }

    #[test]
    fn bbox_union() {
        let a = BBox {
            x: 0.1,
            y: 0.1,
            w: 0.1,
            h: 0.1,
        };
        let b = BBox {
            x: 0.3,
            y: 0.0,
            w: 0.1,
            h: 0.1,
        };
        let u = a.union(&b);
        assert!((u.w - 0.3).abs() < 1e-9 && (u.h - 0.2).abs() < 1e-9);
    }
}
