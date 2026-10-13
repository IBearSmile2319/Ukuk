use axum::Json;
use serde::{Deserialize, Serialize};
use ukuk_core::Finding;
use ukuk_peru::{MrzData, RucValidation};

use crate::analysis::today_lima;
use crate::error::{ApiError, ApiJson};

#[derive(Deserialize)]
pub struct RucRequest {
    pub ruc: String,
}

pub async fn ruc(ApiJson(req): ApiJson<RucRequest>) -> Json<RucValidation> {
    Json(ukuk_peru::ruc::validate(&req.ruc))
}

#[derive(Deserialize)]
pub struct MrzRequest {
    pub mrz: String,
}

#[derive(Serialize)]
pub struct MrzResponse {
    #[serde(flatten)]
    pub mrz: MrzData,
    pub findings: Vec<Finding>,
}

pub async fn mrz(ApiJson(req): ApiJson<MrzRequest>) -> Result<Json<MrzResponse>, ApiError> {
    if req.mrz.trim().is_empty() {
        return Err(ApiError::unprocessable(
            "invalid_request",
            "El campo mrz está vacío.",
        ));
    }
    let a = ukuk_peru::mrz::parse_td1(&req.mrz, today_lima());
    Ok(Json(MrzResponse {
        mrz: a.mrz,
        findings: a.findings,
    }))
}
