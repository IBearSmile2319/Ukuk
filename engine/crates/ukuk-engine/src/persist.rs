//! Persistencia de listas de vigilancia: archivo crudo + metadatos en
//! `UKUK_DATA_DIR/watchlists/`, para recargarlas al reiniciar.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ukuk_names::{Category, IndexedList, ListFormat, ListMeta, ParseError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMeta {
    pub source: String,
    pub category: Category,
    pub format: ListFormat,
    pub entries: usize,
    pub version: String,
    pub loaded_at: String,
}

impl StoredMeta {
    pub fn public(&self) -> ListMeta {
        ListMeta {
            source: self.source.clone(),
            category: self.category,
            entries: self.entries,
            version: self.version.clone(),
            loaded_at: self.loaded_at.clone(),
        }
    }
}

fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("watchlists")
}

pub fn sha256_hex(raw: &[u8]) -> String {
    hex::encode(Sha256::digest(raw))
}

/// Interpreta e indexa una lista cruda (operación costosa: llamar fuera del runtime async).
pub fn build(
    source: &str,
    category: Category,
    format: ListFormat,
    raw: &[u8],
    loaded_at: String,
) -> Result<(IndexedList, StoredMeta), ParseError> {
    let entries = ukuk_names::parse(format, raw)?;
    let meta = StoredMeta {
        source: source.to_string(),
        category,
        format,
        entries: entries.len(),
        version: sha256_hex(raw),
        loaded_at,
    };
    Ok((IndexedList::build(meta.public(), entries), meta))
}

fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    std::fs::rename(tmp, path)
}

pub fn save(data_dir: &Path, meta: &StoredMeta, raw: &[u8]) -> std::io::Result<()> {
    let d = dir(data_dir);
    std::fs::create_dir_all(&d)?;
    write_atomic(&d.join(format!("{}.raw", meta.source)), raw)?;
    let json = serde_json::to_vec_pretty(meta).map_err(std::io::Error::other)?;
    write_atomic(&d.join(format!("{}.json", meta.source)), &json)
}

pub fn delete(data_dir: &Path, source: &str) -> std::io::Result<()> {
    let d = dir(data_dir);
    for ext in ["json", "raw"] {
        match std::fs::remove_file(d.join(format!("{source}.{ext}"))) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

/// Recarga todas las listas persistidas; las que fallan se registran y se omiten.
pub fn load_all(data_dir: &Path) -> Vec<IndexedList> {
    let Ok(read) = std::fs::read_dir(dir(data_dir)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let result = (|| -> Result<IndexedList, String> {
            let meta: StoredMeta =
                serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            let raw = std::fs::read(path.with_extension("raw")).map_err(|e| e.to_string())?;
            if sha256_hex(&raw) != meta.version {
                return Err("el archivo crudo no coincide con su versión".into());
            }
            let (list, _) = build(
                &meta.source,
                meta.category,
                meta.format,
                &raw,
                meta.loaded_at.clone(),
            )
            .map_err(|e| e.to_string())?;
            Ok(list)
        })();
        match result {
            Ok(list) => out.push(list),
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "no se pudo recargar la lista")
            }
        }
    }
    out
}
