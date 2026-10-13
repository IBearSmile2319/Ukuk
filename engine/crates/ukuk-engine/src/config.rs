use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub addr: SocketAddr,
    pub data_dir: Option<PathBuf>,
    pub log_json: bool,
}

impl Config {
    pub const DEFAULT_ADDR: &'static str = "0.0.0.0:8090";

    /// `UKUK_ENGINE_ADDR` (por defecto 0.0.0.0:8090), `UKUK_DATA_DIR` (opcional) y
    /// `UKUK_LOG_FORMAT=json` para logs JSON.
    pub fn from_env() -> Result<Self, String> {
        let addr =
            std::env::var("UKUK_ENGINE_ADDR").unwrap_or_else(|_| Self::DEFAULT_ADDR.to_string());
        let addr = addr
            .parse()
            .map_err(|e| format!("UKUK_ENGINE_ADDR inválido ({addr}): {e}"))?;
        let data_dir = std::env::var_os("UKUK_DATA_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let log_json =
            std::env::var("UKUK_LOG_FORMAT").is_ok_and(|v| v.eq_ignore_ascii_case("json"));
        Ok(Self {
            addr,
            data_dir,
            log_json,
        })
    }
}
