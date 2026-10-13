pub mod analyze;
pub mod rules;
pub mod screen;
pub mod watchlists;

use axum::Json;
use axum::http::StatusCode;
use serde_json::{Value, json};
use ukuk_core::ENGINE_VERSION;

use crate::ApiError;

pub async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "version": ENGINE_VERSION }))
}

pub async fn not_found() -> ApiError {
    ApiError::not_found("not_found", "Ruta no encontrada.")
}

pub async fn method_not_allowed() -> ApiError {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "method_not_allowed",
        "Método no permitido para esta ruta.",
    )
}
