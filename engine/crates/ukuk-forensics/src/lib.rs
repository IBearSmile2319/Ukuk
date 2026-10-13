//! Forense documental: imágenes (calidad, dHash, ELA, copy-move, EXIF), PDF
//! estructural, XML UBL de SUNAT, consistencia de disposición OCR y plantillas.

pub mod image;
pub mod layout;
pub mod pdf;
pub mod template;
pub mod xml;

pub use image::dhash::{hamming, hamming_u64};
pub use image::text_marks::analyze_text_marks;
pub use image::{ImageAnalysis, ImageReport, analyze_image, decode};
pub use layout::analyze_layout;
pub use pdf::{PdfAnalysis, PdfReport, analyze_pdf};
pub use template::{Anchor, Template, compare_template};
pub use xml::{XmlAnalysis, XmlReport, analyze_xml};
