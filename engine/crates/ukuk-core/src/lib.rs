//! Tipos compartidos por todos los crates del motor: hallazgos (`Finding`),
//! regiones normalizadas, palabras OCR, tipo de documento y campos impresos.

mod fields;
mod finding;

pub use fields::{DocumentFields, DocumentType};
pub use finding::{BBox, Finding, Layer, OcrWord, Region, Severity};

/// Versión del motor reportada en `/health` y en cada análisis.
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
