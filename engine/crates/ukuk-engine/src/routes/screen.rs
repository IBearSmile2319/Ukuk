use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use ukuk_names::{EntryKind, IndexedList, ScreenMatch, ScreenQuery};

use crate::AppState;
use crate::error::{ApiError, ApiJson};

const MAX_LIMIT: usize = 1000;

#[derive(Serialize)]
pub struct ScreenResponse {
    pub query_normalized: String,
    pub matches: Vec<ScreenMatch>,
}

fn validate_common(threshold: Option<f64>, limit: Option<usize>) -> Result<(), ApiError> {
    if let Some(t) = threshold
        && !(0.0..=1.0).contains(&t)
    {
        return Err(ApiError::unprocessable(
            "invalid_request",
            "threshold debe estar entre 0 y 1.",
        ));
    }
    if limit.is_some_and(|l| l > MAX_LIMIT) {
        return Err(ApiError::unprocessable(
            "invalid_request",
            format!("limit no puede superar {MAX_LIMIT}."),
        ));
    }
    Ok(())
}

/// Listas a consultar. Pedir una lista no cargada es un error (evita falsos negativos silenciosos).
fn select_lists(
    state: &AppState,
    sources: Option<&[String]>,
) -> Result<Vec<Arc<IndexedList>>, ApiError> {
    let lists = state.snapshot();
    if let Some(sources) = sources {
        let missing: Vec<&str> = sources
            .iter()
            .filter(|s| !lists.iter().any(|l| &l.meta.source == *s))
            .map(String::as_str)
            .collect();
        if !missing.is_empty() {
            return Err(ApiError::not_found(
                "unknown_source",
                format!("Listas no cargadas: {}.", missing.join(", ")),
            ));
        }
    }
    Ok(lists)
}

pub async fn screen(
    State(state): State<AppState>,
    ApiJson(query): ApiJson<ScreenQuery>,
) -> Result<Json<ScreenResponse>, ApiError> {
    validate_common(query.threshold, query.limit)?;
    let query_normalized = ukuk_names::prepare(&query.name).normalized;
    if query_normalized.is_empty() {
        return Err(ApiError::unprocessable(
            "invalid_request",
            "El nombre está vacío.",
        ));
    }
    let lists = select_lists(&state, query.sources.as_deref())?;
    let matches = tokio::task::spawn_blocking(move || ukuk_names::screen(&lists, &query)).await?;
    Ok(Json(ScreenResponse {
        query_normalized,
        matches,
    }))
}

#[derive(Deserialize)]
pub struct Subject {
    #[serde(rename = "ref")]
    pub reference: String,
    pub name: String,
    #[serde(default)]
    pub kind: Option<EntryKind>,
    #[serde(default)]
    pub birth_date: Option<String>,
    #[serde(default)]
    pub nationality: Option<String>,
}

#[derive(Deserialize)]
pub struct BatchRequest {
    pub subjects: Vec<Subject>,
    #[serde(default)]
    pub threshold: Option<f64>,
    #[serde(default)]
    pub sources: Option<Vec<String>>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Serialize)]
pub struct BatchResult {
    #[serde(rename = "ref")]
    pub reference: String,
    pub matches: Vec<ScreenMatch>,
}

#[derive(Serialize)]
pub struct BatchResponse {
    pub results: Vec<BatchResult>,
}

pub async fn batch(
    State(state): State<AppState>,
    ApiJson(req): ApiJson<BatchRequest>,
) -> Result<Json<BatchResponse>, ApiError> {
    validate_common(req.threshold, req.limit)?;
    let lists = select_lists(&state, req.sources.as_deref())?;
    let results = tokio::task::spawn_blocking(move || {
        let queries: Vec<ScreenQuery> = req
            .subjects
            .iter()
            .map(|s| ScreenQuery {
                name: s.name.clone(),
                kind: s.kind,
                birth_date: s.birth_date.clone(),
                nationality: s.nationality.clone(),
                threshold: req.threshold,
                sources: req.sources.clone(),
                limit: req.limit,
            })
            .collect();
        let matches = ukuk_names::screen_batch(&lists, &queries);
        req.subjects
            .into_iter()
            .zip(matches)
            .map(|(s, matches)| BatchResult {
                reference: s.reference,
                matches,
            })
            .collect()
    })
    .await?;
    Ok(Json(BatchResponse { results }))
}
