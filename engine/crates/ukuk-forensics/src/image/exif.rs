//! Metadatos EXIF (y XMP CreatorTool como respaldo).

use std::io::Cursor;

use exif::{In, Tag, Value};
use serde::{Deserialize, Serialize};
use serde_json::json;
use ukuk_core::{Finding, Layer, Severity};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ExifInfo {
    pub software: Option<String>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub datetime_original: Option<String>,
    pub has_gps: bool,
}

/// Editores de contenido (alteran píxeles) y editores de ajuste (color, recorte).
const CONTENT_EDITORS: &[&str] = &[
    "photoshop",
    "gimp",
    "photopea",
    "canva",
    "picsart",
    "pixlr",
    "affinity",
    "paint.net",
    "paintshop",
    "corel",
    "pixelmator",
    "fotor",
    "facetune",
    "meitu",
    "inpixio",
    "photodirector",
];
const ADJUST_EDITORS: &[&str] = &[
    "lightroom",
    "snapseed",
    "vsco",
    "polarr",
    "luminar",
    "capture one",
    "acdsee",
    "remini",
    "picsart",
    "inshot",
    "darktable",
    "rawtherapee",
];

fn ascii(field: Option<&exif::Field>) -> Option<String> {
    let f = field?;
    match &f.value {
        Value::Ascii(parts) => {
            let s = parts
                .iter()
                .map(|p| {
                    String::from_utf8_lossy(p)
                        .trim_matches(char::from(0))
                        .trim()
                        .to_string()
                })
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            (!s.is_empty()).then_some(s)
        }
        _ => {
            let s = f.display_value().to_string();
            (!s.is_empty()).then_some(s)
        }
    }
}

/// Busca `xmp:CreatorTool` en un paquete XMP incrustado.
fn xmp_creator_tool(bytes: &[u8]) -> Option<String> {
    let finder = memchr::memmem::find(bytes, b"CreatorTool")?;
    let tail = &bytes[finder + "CreatorTool".len()..bytes.len().min(finder + 300)];
    let tail = String::from_utf8_lossy(tail);
    let value = if let Some(rest) = tail.strip_prefix('>') {
        rest.split('<').next()?
    } else {
        let rest = tail.trim_start().strip_prefix('=')?.trim_start();
        let quote = rest.chars().next()?;
        rest[1..].split(quote).next()?
    };
    let v = value.trim();
    (!v.is_empty()).then(|| v.to_string())
}

pub fn read(bytes: &[u8]) -> Option<ExifInfo> {
    let parsed = exif::Reader::new()
        .read_from_container(&mut Cursor::new(bytes))
        .ok();
    let mut info = ExifInfo::default();
    if let Some(e) = &parsed {
        info.software = ascii(e.get_field(Tag::Software, In::PRIMARY));
        info.make = ascii(e.get_field(Tag::Make, In::PRIMARY));
        info.model = ascii(e.get_field(Tag::Model, In::PRIMARY));
        info.datetime_original = ascii(e.get_field(Tag::DateTimeOriginal, In::PRIMARY));
        info.has_gps = e.fields().any(|f| f.tag.context() == exif::Context::Gps);
    }
    if info.software.is_none() {
        info.software = xmp_creator_tool(bytes);
    }
    let empty = info == ExifInfo::default();
    (parsed.is_some() || !empty).then_some(info)
}

pub fn findings(info: &ExifInfo) -> Vec<Finding> {
    let Some(sw) = info.software.as_deref() else {
        return Vec::new();
    };
    let lower = sw.to_lowercase();
    let content = CONTENT_EDITORS.iter().find(|e| lower.contains(*e));
    let adjust = ADJUST_EDITORS.iter().find(|e| lower.contains(*e));
    let (editor, severity) = match (content, adjust) {
        (Some(e), _) => (e, Severity::High),
        (None, Some(e)) => (e, Severity::Medium),
        (None, None) => return Vec::new(),
    };
    vec![
        Finding::new(
            "exif.editing_software",
            Layer::Forensics,
            severity,
            0.75,
            format!("Los metadatos indican que la imagen pasó por un editor ({sw})."),
        )
        .with_evidence(json!({ "software": sw, "editor": editor })),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::testutil::*;

    /// Inserta un segmento APP1 Exif mínimo (IFD0 con Software y Make, IFD GPS) en un JPEG.
    fn jpeg_with_exif(software: &str) -> Vec<u8> {
        let jpeg = encode_jpeg(&textured_rgb(64, 64, 1), 80);
        let mut sw = software.as_bytes().to_vec();
        sw.push(0);
        let make = b"ACME\0".to_vec();
        // TIFF little endian; IFD0 en offset 8 con 3 entradas.
        let mut tiff = b"II*\0".to_vec();
        tiff.extend(8u32.to_le_bytes());
        let n = 3u16;
        let ifd_size = 2 + 12 * u32::from(n) + 4;
        let data_off = 8 + ifd_size;
        let gps_off = data_off + sw.len() as u32 + make.len() as u32;
        tiff.extend(n.to_le_bytes());
        // Make (0x010F)
        tiff.extend(0x010Fu16.to_le_bytes());
        tiff.extend(2u16.to_le_bytes());
        tiff.extend((make.len() as u32).to_le_bytes());
        tiff.extend((data_off + sw.len() as u32).to_le_bytes());
        // Software (0x0131)
        tiff.extend(0x0131u16.to_le_bytes());
        tiff.extend(2u16.to_le_bytes());
        tiff.extend((sw.len() as u32).to_le_bytes());
        tiff.extend(data_off.to_le_bytes());
        // GPSInfo IFD pointer (0x8825)
        tiff.extend(0x8825u16.to_le_bytes());
        tiff.extend(4u16.to_le_bytes());
        tiff.extend(1u32.to_le_bytes());
        tiff.extend(gps_off.to_le_bytes());
        tiff.extend(0u32.to_le_bytes());
        tiff.extend(&sw);
        tiff.extend(&make);
        // GPS IFD: GPSVersionID
        tiff.extend(1u16.to_le_bytes());
        tiff.extend(0x0000u16.to_le_bytes());
        tiff.extend(1u16.to_le_bytes());
        tiff.extend(4u32.to_le_bytes());
        tiff.extend([2u8, 3, 0, 0]);
        tiff.extend(0u32.to_le_bytes());
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend(tiff);
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
        out.extend(((app1.len() + 2) as u16).to_be_bytes());
        out.extend(app1);
        out.extend(&jpeg[2..]);
        out
    }

    #[test]
    fn reads_software_and_gps() {
        let bytes = jpeg_with_exif("Adobe Photoshop 25.0 (Windows)");
        let info = read(&bytes).expect("exif");
        assert_eq!(
            info.software.as_deref(),
            Some("Adobe Photoshop 25.0 (Windows)")
        );
        assert_eq!(info.make.as_deref(), Some("ACME"));
        assert!(info.has_gps);
        let f = findings(&info);
        assert_eq!(f[0].code, "exif.editing_software");
        assert_eq!(f[0].severity, Severity::High);
        // la imagen sigue siendo decodificable
        assert!(crate::image::analyze_image(&bytes).is_ok());
    }

    #[test]
    fn adjust_editor_is_medium_and_camera_firmware_is_clean() {
        let info = ExifInfo {
            software: Some("Snapseed 2.0".into()),
            ..Default::default()
        };
        assert_eq!(findings(&info)[0].severity, Severity::Medium);
        let info = ExifInfo {
            software: Some("G991BXXU5CVF1".into()),
            ..Default::default()
        };
        assert!(findings(&info).is_empty());
    }

    #[test]
    fn no_exif() {
        assert!(read(&encode_jpeg(&textured_rgb(32, 32, 1), 80)).is_none());
    }

    #[test]
    fn xmp_fallback() {
        let mut bytes = encode_jpeg(&textured_rgb(32, 32, 1), 80);
        bytes.extend_from_slice(
            b"<x:xmpmeta><rdf:Description xmp:CreatorTool=\"Canva\"/></x:xmpmeta>",
        );
        assert_eq!(xmp_creator_tool(&bytes).as_deref(), Some("Canva"));
        assert_eq!(
            xmp_creator_tool(b"<xmp:CreatorTool>GIMP 2.10</xmp:CreatorTool>").as_deref(),
            Some("GIMP 2.10")
        );
    }
}
