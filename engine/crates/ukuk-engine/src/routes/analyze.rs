use std::time::Instant;

use axum::Json;

use crate::analysis::{self, AnalyzeRequest, AnalyzeResponse};
use crate::error::{ApiError, ApiJson};

pub async fn analyze(
    ApiJson(req): ApiJson<AnalyzeRequest>,
) -> Result<Json<AnalyzeResponse>, ApiError> {
    let start = Instant::now();
    let today = analysis::today_lima();
    let mut resp = tokio::task::spawn_blocking(move || analysis::run(req, today)).await??;
    resp.duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    tracing::info!(
        sha256 = %resp.sha256,
        mime = %resp.mime_type,
        findings = resp.findings.len(),
        duration_ms = resp.duration_ms,
        "análisis completado"
    );
    Ok(Json(resp))
}
