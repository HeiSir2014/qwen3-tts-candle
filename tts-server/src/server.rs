use std::sync::Arc;
use std::time::Duration;

use axum::http::{HeaderName, Request};
use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::{Any, CorsLayer};
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::trace::TraceLayer;
use tracing::Span;

use crate::routes;
use crate::state::AppState;

static X_REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

/// Build the Axum router with all TTS server routes.
pub fn build_router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // HTTP tracing middleware — logs method, URI, status, latency per request
    let trace_layer = TraceLayer::new_for_http()
        .make_span_with(|request: &Request<_>| {
            let request_id = request
                .headers()
                .get("x-request-id")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("-");
            tracing::info_span!(
                "http",
                method = %request.method(),
                uri = %request.uri(),
                request_id = %request_id,
            )
        })
        .on_response(
            |response: &axum::http::Response<_>, latency: Duration, _span: &Span| {
                tracing::info!(
                    status = response.status().as_u16(),
                    latency_ms = latency.as_millis() as u64,
                    "response"
                );
            },
        )
        .on_failure(
            |error: tower_http::classify::ServerErrorsFailureClass,
             latency: Duration,
             _span: &Span| {
                tracing::error!(
                    error = %error,
                    latency_ms = latency.as_millis() as u64,
                    "request failed"
                );
            },
        );

    Router::new()
        .route("/health", get(routes::health))
        .route("/extract-embedding", post(routes::extract_embedding))
        .route("/clone-stream", post(routes::clone_stream))
        .route("/cache/clear", post(routes::clear_cache))
        .with_state(state)
        .layer(cors)
        .layer(trace_layer)
        // Propagate X-Request-Id from request to response
        .layer(PropagateRequestIdLayer::new(X_REQUEST_ID.clone()))
        // Generate X-Request-Id if not present
        .layer(SetRequestIdLayer::new(
            X_REQUEST_ID.clone(),
            MakeRequestUuid,
        ))
}
