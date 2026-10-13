use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use ukuk_names::{Category, ListFormat, ListMeta};

use crate::persist;
use crate::{ApiError, AppState};

#[derive(Deserialize)]
pub struct UploadParams {
    pub format: Option<String>,
    pub category: Option<String>,
}

pub fn valid_source(s: &str) -> bool {
    (1..=40).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn check_source(source: &str) -> Result<(), ApiError> {
    if valid_source(source) {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "invalid_source",
            "El identificador de lista debe cumplir [a-z0-9_-]{1,40}.",
        ))
    }
}

pub async fn upload(
    State(state): State<AppState>,
    Path(source): Path<String>,
    Query(params): Query<UploadParams>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<ListMeta>, ApiError> {
    check_source(&source)?;
    let format = params
        .format
        .as_deref()
        .and_then(ListFormat::parse)
        .ok_or_else(|| {
            ApiError::bad_request(
                "invalid_format",
                "format debe ser ofac_sdn_csv, un_xml o ukuk_jsonl.",
            )
        })?;
    let category = match params.category.as_deref() {
        None | Some("") => Category::Sanction,
        Some(c) => Category::parse(c).ok_or_else(|| {
            ApiError::bad_request(
                "invalid_category",
                "category debe ser sanction, pep o interest.",
            )
        })?,
    };
    let raw = body?;
    if raw.is_empty() {
        return Err(ApiError::bad_request("empty_body", "El cuerpo está vacío."));
    }

    let data_dir = state.data_dir.clone();
    let src = source.clone();
    let (list, meta) = tokio::task::spawn_blocking(move || {
        let loaded_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let (list, meta) = persist::build(&src, category, format, &raw, loaded_at)
            .map_err(|e| ApiError::unprocessable("invalid_watchlist", e.to_string()))?;
        if let Some(dir) = &data_dir {
            persist::save(dir, &meta, &raw)
                .map_err(|e| ApiError::internal(format!("no se pudo guardar la lista: {e}")))?;
        }
        Ok::<_, ApiError>((list, meta))
    })
    .await??;

    state
        .watchlists
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .insert(source.clone(), Arc::new(list));
    tracing::info!(source = %source, entries = meta.entries, version = %meta.version, "lista cargada");
    Ok(Json(meta.public()))
}

pub async fn list(State(state): State<AppState>) -> Json<Vec<ListMeta>> {
    Json(state.snapshot().iter().map(|l| l.meta.clone()).collect())
}

pub async fn remove(
    State(state): State<AppState>,
    Path(source): Path<String>,
) -> Result<StatusCode, ApiError> {
    check_source(&source)?;
    let removed = state
        .watchlists
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&source);
    if removed.is_none() {
        return Err(ApiError::not_found(
            "not_found",
            format!("La lista «{source}» no está cargada."),
        ));
    }
    if let Some(dir) = state.data_dir.clone() {
        let src = source.clone();
        tokio::task::spawn_blocking(move || persist::delete(&dir, &src))
            .await?
            .map_err(|e| ApiError::internal(format!("no se pudo borrar la lista: {e}")))?;
    }
    tracing::info!(source = %source, "lista eliminada");
    Ok(StatusCode::NO_CONTENT)
}
