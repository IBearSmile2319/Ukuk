//! Servicio HTTP del motor Ukuk. Ver `docs/contrato-motor.md`.

pub mod analysis;
pub mod config;
pub mod error;
pub mod persist;
pub mod routes;
pub mod state;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post, put};
use tower_http::trace::TraceLayer;

pub use config::Config;
pub use error::ApiError;
pub use state::AppState;

/// Límite de cuerpo para `/v1/analyze` y demás rutas JSON.
pub const BODY_LIMIT: usize = 25 * 1024 * 1024;
/// Las listas de vigilancia crudas pueden ser más grandes que un documento.
pub const WATCHLIST_BODY_LIMIT: usize = 200 * 1024 * 1024;

pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(routes::health))
        .route("/v1/analyze", post(routes::analyze::analyze))
        .route("/v1/rules/ruc", post(routes::rules::ruc))
        .route("/v1/rules/mrz", post(routes::rules::mrz))
        .route("/v1/watchlists", get(routes::watchlists::list))
        .route(
            "/v1/watchlists/{source}",
            put(routes::watchlists::upload)
                .delete(routes::watchlists::remove)
                .layer(DefaultBodyLimit::max(WATCHLIST_BODY_LIMIT)),
        )
        .route("/v1/screen", post(routes::screen::screen))
        .route("/v1/screen/batch", post(routes::screen::batch))
        .fallback(routes::not_found)
        .method_not_allowed_fallback(routes::method_not_allowed)
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
