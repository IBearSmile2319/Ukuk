//! Pruebas de integración de la API HTTP con `tower::ServiceExt::oneshot`.

use std::path::PathBuf;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use http_body_util::BodyExt;
use image::codecs::jpeg::JpegEncoder;
use image::{Rgb, RgbImage};
use serde_json::{Value, json};
use tower::ServiceExt;
use ukuk_engine::{AppState, app};

const PEP: &[u8] = include_bytes!("../../ukuk-names/tests/fixtures/pep_sample.jsonl");
const SDN: &[u8] = include_bytes!("../../ukuk-names/tests/fixtures/sdn_sample.csv");
const UN: &[u8] = include_bytes!("../../ukuk-names/tests/fixtures/un_sample.xml");

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ukuk-engine-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn router() -> Router {
    app(AppState::new(None))
}

async fn send(app: &Router, req: Request<Body>) -> (StatusCode, Value) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()))
    };
    (status, body)
}

fn post_json(uri: &str, body: &Value) -> Request<Body> {
    Request::post(uri)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(body).unwrap()))
        .unwrap()
}

fn put_raw(uri: &str, body: &[u8]) -> Request<Body> {
    Request::put(uri).body(Body::from(body.to_vec())).unwrap()
}

fn codes(v: &Value) -> Vec<String> {
    v["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["code"].as_str().unwrap().to_string())
        .collect()
}

fn jpeg(w: u32, h: u32) -> Vec<u8> {
    let mut state = 7u64;
    let img = RgbImage::from_fn(w, h, |x, y| {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
        let n = ((state >> 33) % 40) as f64;
        let v = (110.0 + 50.0 * ((x as f64 / 31.0).sin() + (y as f64 / 17.0).cos()) + n) as u8;
        Rgb([v, v, v])
    });
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 90)
        .encode_image(&img)
        .unwrap();
    out
}

fn simple_pdf(producer: &str) -> Vec<u8> {
    format!(
        "%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n5 0 obj << /Length 44 >>\nstream\nBT /F1 12 Tf 72 712 Td (TOTAL 118.00) Tj ET\nendstream\nendobj\n6 0 obj << /Producer ({producer}) /CreationDate (D:20260315100000-05'00') /ModDate (D:20260315100000-05'00') >> endobj\ntrailer << /Root 1 0 R /Info 6 0 R >>\nstartxref\n0\n%%EOF\n"
    )
    .into_bytes()
}

const UBL: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <ds:Signature Id="S"><ds:SignatureValue>x</ds:SignatureValue></ds:Signature>
  <cbc:ID>F001-00001234</cbc:ID>
  <cbc:IssueDate>2026-03-15</cbc:IssueDate>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6">20100047218</cbc:ID></cac:PartyIdentification></cac:Party></cac:AccountingSupplierParty>
  <cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="PEN">118.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
</Invoice>"#;

fn analyze_body(bytes: &[u8], mime: &str, extra: Value) -> Value {
    let mut body = json!({ "file_base64": STANDARD.encode(bytes), "mime_type": mime });
    if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
        b.extend(e.clone());
    }
    body
}

#[tokio::test]
async fn health() {
    let (s, v) = send(
        &router(),
        Request::get("/health").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v, json!({ "status": "ok", "version": "0.1.0" }));
}

#[tokio::test]
async fn unknown_route_and_method() {
    let (s, v) = send(
        &router(),
        Request::get("/nope").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(v["error"], "not_found");
    let (s, v) = send(
        &router(),
        Request::get("/v1/analyze").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(v["error"], "method_not_allowed");
}

#[tokio::test]
async fn rules_ruc() {
    let app = router();
    let (s, v) = send(
        &app,
        post_json("/v1/rules/ruc", &json!({ "ruc": "20100047218" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v, json!({ "valid": true, "kind": "persona_juridica" }));
    let (_, v) = send(
        &app,
        post_json("/v1/rules/ruc", &json!({ "ruc": "10467793540" })),
    )
    .await;
    assert_eq!(v, json!({ "valid": false, "kind": "persona_natural" }));
    let (_, v) = send(&app, post_json("/v1/rules/ruc", &json!({ "ruc": "abc" }))).await;
    assert_eq!(v, json!({ "valid": false, "kind": "desconocido" }));
    let (s, v) = send(&app, post_json("/v1/rules/ruc", &json!({}))).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(v["error"], "invalid_request");
}

#[tokio::test]
async fn rules_mrz() {
    let mrz = ukuk_peru::mrz::testing::build_td1(
        "12345678",
        "900531",
        'M',
        "400101",
        "PEREZ GARCIA",
        "JUAN CARLOS",
        "",
    );
    let (s, v) = send(
        &router(),
        post_json("/v1/rules/mrz", &json!({ "mrz": mrz })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["valid"], true);
    assert_eq!(v["document_number"], "12345678");
    assert_eq!(v["birth_date"], "1990-05-31");
    assert_eq!(v["surnames"], "PEREZ GARCIA");
    assert_eq!(
        v["checks"],
        json!({ "document_number": true, "birth_date": true, "expiry_date": true, "composite": true })
    );
    assert_eq!(v["findings"], json!([]));

    let (s, v) = send(
        &router(),
        post_json("/v1/rules/mrz", &json!({ "mrz": "I<PER\nxx" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["valid"], false);
    assert_eq!(v["findings"][0]["code"], "mrz.invalid_format");
}

#[tokio::test]
async fn analyze_image_contract_shape() {
    let bytes = jpeg(800, 600);
    let (s, v) = send(
        &router(),
        post_json(
            "/v1/analyze",
            &analyze_body(&bytes, "image/jpeg", json!({ "document_type": "dni" })),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["engine_version"], "0.1.0");
    assert_eq!(v["mime_type"], "image/jpeg");
    assert_eq!(v["sha256"].as_str().unwrap().len(), 64);
    let img = &v["image"];
    assert_eq!(img["width"], 800);
    assert_eq!(img["height"], 600);
    assert_eq!(img["dhash"].as_str().unwrap().len(), 16);
    for k in [
        "blur_variance",
        "brightness",
        "contrast",
        "glare_ratio",
        "megapixels",
    ] {
        assert!(img["quality"][k].is_number(), "{k}");
    }
    for k in ["mean", "max", "suspicious_regions"] {
        assert!(img["ela"][k].is_number(), "{k}");
    }
    assert!(img["exif"].is_null());
    assert!(v["pdf"].is_null() && v["xml"].is_null() && v["mrz"].is_null());
    assert!(v["duration_ms"].is_number());
    assert!(codes(&v).contains(&"template.none".to_string()));
    let f = &v["findings"][0];
    for k in [
        "code",
        "layer",
        "severity",
        "confidence",
        "message",
        "region",
        "evidence",
    ] {
        assert!(f.get(k).is_some(), "{k}");
    }
}

#[tokio::test]
async fn analyze_dni_with_mrz_and_fields() {
    let mrz = ukuk_peru::mrz::testing::build_td1(
        "12345678",
        "900531",
        'M',
        "400101",
        "PEREZ GARCIA",
        "JUAN CARLOS",
        "",
    );
    let extra = json!({
        "document_type": "dni",
        "fields": {
            "dni": "12345678", "apellidos": "Pérez García", "nombres": "Juan Carlos",
            "fecha_nacimiento": "1990-05-31", "fecha_vencimiento": "2040-01-01", "sexo": "F", "mrz": mrz
        }
    });
    let (s, v) = send(
        &router(),
        post_json(
            "/v1/analyze",
            &analyze_body(&jpeg(800, 600), "image/jpeg", extra),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["mrz"]["valid"], true);
    assert_eq!(v["mrz"]["nationality"], "PER");
    let c = codes(&v);
    assert!(c.contains(&"mrz.sex_mismatch".to_string()), "{c:?}");
    assert!(!c.contains(&"mrz.surname_mismatch".to_string()));
}

/// Un carnet mezcla tamaños a propósito (CUI grande junto a etiquetas pequeñas): la
/// revisión de diseño genérica no aplica al DNI, sí a una boleta.
#[tokio::test]
async fn layout_check_skips_id_cards() {
    let mut words = Vec::new();
    for (li, line) in [
        ["Apellidos", "Nombres", "Sexo", "PER"],
        ["Estado", "civil", "SOLTERO", "Fecha"],
        ["Nro", "tarjeta", "CUI", "12345678-1"],
    ]
    .iter()
    .enumerate()
    {
        let base = 0.2 + li as f64 * 0.1;
        for (i, t) in line.iter().enumerate() {
            let h = if *t == "12345678-1" { 0.03 } else { 0.0144 };
            words.push(json!({ "text": t, "confidence": 0.99, "page": 1, "bbox": { "x": 0.1 + i as f64 * 0.2, "y": base - h, "w": 0.1, "h": h } }));
        }
    }
    let layout = |document_type: &str| {
        let extra = json!({ "document_type": document_type, "ocr_words": words.clone() });
        async move {
            let (s, v) = send(
                &router(),
                post_json(
                    "/v1/analyze",
                    &analyze_body(&jpeg(800, 600), "image/jpeg", extra),
                ),
            )
            .await;
            assert_eq!(s, StatusCode::OK, "{v}");
            codes(&v)
                .into_iter()
                .filter(|c| c.starts_with("layout."))
                .count()
        }
    };
    assert!(layout("boleta_venta").await > 0);
    assert_eq!(layout("dni").await, 0);
}

#[tokio::test]
async fn analyze_invoice_pdf() {
    let extra = json!({
        "document_type": "factura",
        "fields": { "ruc_emisor": "20100047219", "serie_numero": "B001-123", "subtotal": "100.00", "igv": "18.00", "total": "120.00", "fecha_emision": "2026-02-30" },
        "ocr_words": [
            { "text": "RUC", "confidence": 0.99, "page": 1, "bbox": { "x": 0.1, "y": 0.1, "w": 0.05, "h": 0.0144 } }
        ],
        "template": { "id": "t", "label": "Formato X", "anchors": [ { "text": "RUC", "bbox": { "x": 0.5, "y": 0.5, "w": 0.05, "h": 0.0144 } } ], "tolerance": 0.03 }
    });
    let (s, v) = send(
        &router(),
        post_json(
            "/v1/analyze",
            &analyze_body(&simple_pdf("iLovePDF"), "application/pdf", extra),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let pdf = &v["pdf"];
    assert_eq!(pdf["version"], "1.7");
    assert_eq!(pdf["pages"], 1);
    assert_eq!(pdf["producer"], "iLovePDF");
    assert_eq!(pdf["fonts"], json!(["Helvetica"]));
    assert_eq!(pdf["has_text_layer"], true);
    assert_eq!(pdf["encrypted"], false);
    assert!(v["image"].is_null());
    let c = codes(&v);
    for expected in [
        "pdf.editing_software",
        "ruc.invalid",
        "invoice.serie_format",
        "invoice.totals_mismatch",
        "dates.invalid_date",
        "template.anchor_displaced",
    ] {
        assert!(c.contains(&expected.to_string()), "{expected} not in {c:?}");
    }
    // Ordenados por severidad descendente.
    let order = ["critical", "high", "medium", "low", "info"];
    let ranks: Vec<usize> = v["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| order.iter().position(|o| *o == f["severity"]).unwrap())
        .collect();
    assert!(ranks.windows(2).all(|w| w[0] <= w[1]));
}

#[tokio::test]
async fn analyze_xml_against_fields() {
    let extra = json!({ "fields": { "ruc_emisor": "20100047218", "serie_numero": "F001-1234", "total": "181.00", "fecha_emision": "2026-03-15" } });
    let (s, v) = send(
        &router(),
        post_json(
            "/v1/analyze",
            &analyze_body(UBL.as_bytes(), "text/xml", extra),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["xml"]["is_sunat_ubl"], true);
    assert_eq!(v["xml"]["has_signature"], true);
    assert_eq!(v["xml"]["total"], "118.00");
    let mismatches: Vec<&Value> = v["findings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["code"] == "xml.mismatch_with_pdf")
        .collect();
    assert_eq!(mismatches.len(), 1);
    assert_eq!(mismatches[0]["evidence"]["field"], "total");
}

#[tokio::test]
async fn analyze_mime_mismatch_and_corrupt_files() {
    let app = router();
    // PDF declarado como JPEG: se analiza como PDF.
    let (s, v) = send(
        &app,
        post_json(
            "/v1/analyze",
            &analyze_body(&simple_pdf("X"), "image/jpeg", json!({})),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["mime_type"], "application/pdf");
    assert!(codes(&v).contains(&"file.mime_mismatch".to_string()));
    assert!(v["pdf"].is_object());
    // JPEG truncado.
    let mut broken = jpeg(200, 200);
    broken.truncate(200);
    let (s, v) = send(
        &app,
        post_json(
            "/v1/analyze",
            &analyze_body(&broken, "image/jpeg", json!({})),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert!(codes(&v).contains(&"file.unreadable".to_string()));
    assert!(v["image"].is_null());
}

#[tokio::test]
async fn analyze_errors() {
    let app = router();
    let (s, v) = send(
        &app,
        post_json(
            "/v1/analyze",
            &json!({ "file_base64": "%%%", "mime_type": "image/png" }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "invalid_base64");
    let (s, v) = send(
        &app,
        post_json(
            "/v1/analyze",
            &json!({ "file_base64": "aG9sYQ==", "mime_type": "application/zip" }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "unsupported_mime_type");
    let (s, v) = send(
        &app,
        post_json("/v1/analyze", &json!({ "mime_type": "image/png" })),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(v["error"], "invalid_request");
    let req = Request::post("/v1/analyze")
        .header("content-type", "application/json")
        .body(Body::from("{not json"))
        .unwrap();
    let (s, v) = send(&app, req).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "invalid_json");
    let req = Request::post("/v1/analyze").body(Body::from("{}")).unwrap();
    let (s, _) = send(&app, req).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn body_limit_is_25_mb() {
    let big = vec![b'a'; 26 * 1024 * 1024];
    let req = Request::post("/v1/analyze")
        .header("content-type", "application/json")
        .body(Body::from(big))
        .unwrap();
    let (s, v) = send(&router(), req).await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(v["error"], "payload_too_large");
}

#[tokio::test]
async fn watchlist_lifecycle_and_screening() {
    let app = router();
    let (s, v) = send(
        &app,
        put_raw("/v1/watchlists/pep_pe?format=ukuk_jsonl&category=pep", PEP),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["source"], "pep_pe");
    assert_eq!(v["category"], "pep");
    assert_eq!(v["entries"], 3);
    assert_eq!(v["version"].as_str().unwrap().len(), 64);
    assert!(v["loaded_at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(v.as_object().unwrap().len(), 5);

    let (s, v) = send(
        &app,
        put_raw("/v1/watchlists/ofac_sdn?format=ofac_sdn_csv", SDN),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["category"], "sanction");
    let (s, _) = send(&app, put_raw("/v1/watchlists/un?format=un_xml", UN)).await;
    assert_eq!(s, StatusCode::OK);

    let (_, v) = send(
        &app,
        Request::get("/v1/watchlists").body(Body::empty()).unwrap(),
    )
    .await;
    let sources: Vec<&str> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["source"].as_str().unwrap())
        .collect();
    assert_eq!(sources, vec!["ofac_sdn", "pep_pe", "un"]);

    let (s, v) = send(
        &app,
        post_json(
            "/v1/screen",
            &json!({ "name": "Juan Carlos Pérez de la Cruz", "kind": "individual", "birth_date": "1970-02-03", "nationality": "PE" }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["query_normalized"], "JUAN CARLOS PEREZ DE LA CRUZ");
    let m = &v["matches"][0];
    assert_eq!(m["source"], "ofac_sdn");
    assert_eq!(m["category"], "sanction");
    assert_eq!(m["entry_id"], "9002");
    assert_eq!(m["name"], "PEREZ DE LA CRUZ, Juan");
    assert_eq!(m["kind"], "individual");
    assert_eq!(m["programs"], json!(["SDNTK", "ILLICIT-DRUGS"]));
    assert!(m["score"].as_f64().unwrap() >= 0.85);
    assert!(
        m["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r == "fecha de nacimiento coincide")
    );

    let (_, v) = send(
        &app,
        post_json(
            "/v1/screen",
            &json!({ "name": "Gumercindo Ccahuana", "sources": ["ofac_sdn"] }),
        ),
    )
    .await;
    assert_eq!(v["matches"], json!([]));
    let (s, v) = send(
        &app,
        post_json("/v1/screen", &json!({ "name": "X", "sources": ["nope"] })),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(v["error"], "unknown_source");
    let (s, _) = send(
        &app,
        post_json("/v1/screen", &json!({ "name": "X", "threshold": 2 })),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    let (s, _) = send(&app, post_json("/v1/screen", &json!({ "name": "  ,. " }))).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);

    let (s, v) = send(
        &app,
        post_json(
            "/v1/screen/batch",
            &json!({ "subjects": [
                { "ref": "cli-1", "name": "Rosaura Villavicencio de la Puente" },
                { "ref": "cli-2", "name": "Persona Inexistente Total" },
                { "ref": "cli-3", "name": "Abelardo Condorcanqui", "birth_date": "1962-11-04" }
            ], "threshold": 0.8 }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let r = v["results"].as_array().unwrap();
    assert_eq!(r[0]["ref"], "cli-1");
    assert_eq!(r[0]["matches"][0]["entry_id"], "pep-002");
    assert_eq!(r[1]["matches"], json!([]));
    assert_eq!(r[2]["matches"][0]["source"], "un");

    let (s, v) = send(
        &app,
        Request::delete("/v1/watchlists/pep_pe")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert!(v.is_null());
    let (s, v) = send(
        &app,
        Request::delete("/v1/watchlists/pep_pe")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(v["error"], "not_found");
}

#[tokio::test]
async fn watchlist_upload_errors() {
    let app = router();
    let (s, v) = send(
        &app,
        put_raw("/v1/watchlists/Bad.Source?format=ukuk_jsonl", PEP),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "invalid_source");
    let (s, v) = send(&app, put_raw("/v1/watchlists/x?format=pdf", PEP)).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "invalid_format");
    let (s, v) = send(
        &app,
        put_raw("/v1/watchlists/x?format=ukuk_jsonl&category=vip", PEP),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "invalid_category");
    let (s, v) = send(
        &app,
        put_raw("/v1/watchlists/x?format=ukuk_jsonl", b"{broken"),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(v["error"], "invalid_watchlist");
    let (s, _) = send(&app, put_raw("/v1/watchlists/x?format=ukuk_jsonl", b"")).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn watchlists_persist_across_restarts() {
    let dir = temp_dir("persist");
    let app = app(AppState::new(Some(dir.clone())));
    let (s, first) = send(
        &app,
        put_raw("/v1/watchlists/pep_pe?format=ukuk_jsonl&category=pep", PEP),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = send(&app, put_raw("/v1/watchlists/un?format=un_xml", UN)).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = send(
        &app,
        Request::delete("/v1/watchlists/un")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::NO_CONTENT);

    // "Reinicio": nuevo estado desde el mismo directorio.
    let restarted = ukuk_engine::app(AppState::load(Some(dir.clone())).await);
    let (_, v) = send(
        &restarted,
        Request::get("/v1/watchlists").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(v, json!([first]));
    let (_, v) = send(
        &restarted,
        post_json(
            "/v1/screen",
            &json!({ "name": "Gumercindo Ccahuana Tello" }),
        ),
    )
    .await;
    assert_eq!(v["matches"][0]["entry_id"], "pep-001");
    let _ = std::fs::remove_dir_all(dir);
}
