use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

use qwen3_tts::{AudioBuffer, Language, SynthesisOptions};

use crate::embedding::SerializablePrompt;
use crate::state::AppState;
use crate::streaming;

/// Size of each audio chunk in PCM bytes sent through the streaming protocol.
/// ~0.8s of 24kHz 16-bit mono audio = 24000 * 2 * 0.8 = 38400 bytes.
const STREAM_CHUNK_PCM_BYTES: usize = 38400;

// ── Request/Response types ──

#[derive(Deserialize)]
pub struct ExtractEmbeddingRequest {
    pub ref_audio_path: String,
    pub ref_text: Option<String>,
    pub output_path: String,
}

#[derive(Serialize)]
pub struct ExtractEmbeddingResponse {
    pub status: String,
    pub output_path: String,
}

#[derive(Deserialize)]
pub struct CloneStreamRequest {
    pub ref_audio_path: String,
    pub ref_text: Option<String>,
    pub text: String,
    pub language: Option<String>,
    pub embedding_path: Option<String>,
    /// Number of codec frames per streaming chunk (default: 10).
    /// Lower = faster TTFB, higher = better throughput.
    pub chunk_frames: Option<usize>,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub model_loaded: bool,
    pub backend: String,
    pub cached_prompts: usize,
    pub queue_size: u32,
    pub uptime_s: u64,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

fn error_json(status: StatusCode, msg: &str) -> Response {
    let body = serde_json::to_string(&ErrorBody {
        error: msg.to_string(),
    })
    .unwrap();
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(Body::from(body))
        .unwrap()
}

/// Extract X-Request-Id from headers (set by middleware).
fn request_id(headers: &HeaderMap) -> String {
    headers
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-")
        .to_string()
}

// ── GET /health ──

pub async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let uptime = state.started_at.elapsed().as_secs();
    let cached = state.cache_size().await;
    let queue = state.get_queue_size().await;

    Json(HealthResponse {
        model_loaded: true,
        backend: state.device_label.clone(),
        cached_prompts: cached,
        queue_size: queue,
        uptime_s: uptime,
    })
}

// ── POST /extract-embedding ──

pub async fn extract_embedding(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ExtractEmbeddingRequest>,
) -> Response {
    let start = Instant::now();
    let rid = request_id(&headers);
    tracing::info!(
        request_id = %rid,
        ref_audio = %req.ref_audio_path,
        ref_text = ?req.ref_text,
        output = %req.output_path,
        "extract_embedding_start"
    );

    // Load reference audio (IO-bound, do before acquiring lock)
    let ref_audio = match AudioBuffer::load(&req.ref_audio_path) {
        Ok(a) => a,
        Err(e) => {
            tracing::error!(request_id = %rid, error = %e, "Failed to load reference audio");
            return error_json(
                StatusCode::BAD_REQUEST,
                &format!("Failed to load reference audio: {}", e),
            );
        }
    };

    state.increment_queue().await;
    let ref_text_owned = req.ref_text.clone();
    let output_path_owned = req.output_path.clone();

    // Run extraction in a blocking task (model is behind std::sync::Mutex)
    let state_clone = Arc::clone(&state);
    let rid2 = rid.clone();
    let result = tokio::task::spawn_blocking(move || {
        let model = state_clone.model.lock().unwrap();
        let ref_text = ref_text_owned.as_deref().filter(|s| !s.trim().is_empty());
        tracing::info!(request_id = %rid2, "Extracting voice clone prompt...");
        let prompt = model.create_voice_clone_prompt(&ref_audio, ref_text)?;

        // Serialize
        let serializable = SerializablePrompt::from_prompt(&prompt, ref_text)?;
        let output_path = Path::new(&output_path_owned);
        if let Some(parent) = output_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        serializable.save(output_path)?;

        Ok::<SerializablePrompt, anyhow::Error>(serializable)
    })
    .await;

    state.decrement_queue().await;

    match result {
        Ok(Ok(serializable)) => {
            // Cache the serialized prompt
            state
                .cache_prompt(req.output_path.clone(), serializable)
                .await;

            let duration_ms = start.elapsed().as_millis() as u64;
            tracing::info!(
                request_id = %rid,
                duration_ms = duration_ms,
                "extract_embedding_complete"
            );

            Json(ExtractEmbeddingResponse {
                status: "ok".to_string(),
                output_path: req.output_path,
            })
            .into_response()
        }
        Ok(Err(e)) => {
            tracing::error!(request_id = %rid, error = %e, duration_ms = start.elapsed().as_millis() as u64, "Embedding extraction failed");
            error_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Embedding extraction failed: {}", e),
            )
        }
        Err(e) => {
            tracing::error!(request_id = %rid, error = %e, "Embedding task panicked");
            error_json(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

// ── POST /clone-stream ──

pub async fn clone_stream(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CloneStreamRequest>,
) -> Response {
    let start = Instant::now();
    let rid = request_id(&headers);
    tracing::info!(
        request_id = %rid,
        text_len = req.text.len(),
        text_preview = %truncate_str(&req.text, 50),
        language = ?req.language,
        has_embedding = req.embedding_path.is_some(),
        "clone_stream_start"
    );

    let language = parse_language(req.language.as_deref());

    // Resolve voice clone prompt (may load from cache/disk/extract)
    let prompt_data = match resolve_prompt_data(&state, &req, &rid).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(request_id = %rid, error = %e, "Failed to resolve voice clone prompt");
            return error_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Prompt resolution failed: {}", e),
            );
        }
    };

    let text = req.text.clone();
    let chunk_frames_val = req.chunk_frames.unwrap_or(10);
    let state_clone = Arc::clone(&state);
    let rid2 = rid.clone();

    // Channel for streaming binary frames to the HTTP response
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(32);

    // Spawn the generation task
    tokio::task::spawn(async move {
        state_clone.increment_queue().await;

        let tx2 = tx.clone();
        let rid3 = rid2.clone();
        let state_for_blocking = Arc::clone(&state_clone);
        let result = tokio::task::spawn_blocking(move || {
            // Lock the model for the duration of generation
            let model = state_for_blocking.model.lock().unwrap();

            // Reconstruct VoiceClonePrompt from serializable data
            let device = model.device().clone();
            let prompt = match prompt_data.to_prompt(&device) {
                Ok(p) => p,
                Err(e) => {
                    let _ = tx2.blocking_send(Ok(streaming::build_error_frame(
                        &format!("Failed to reconstruct prompt: {}", e),
                    )));
                    return Err(e);
                }
            };

            // Use streaming API for true streaming generation
            let options = SynthesisOptions {
                temperature: 0.9,
                top_k: 50,
                top_p: 0.9,
                repetition_penalty: 1.05,
                chunk_frames: chunk_frames_val,
                ..Default::default()
            };

            tracing::info!(request_id = %rid3, "Generation starting...");
            let gen_start = Instant::now();
            let mut total_samples: usize = 0;
            let mut chunk_index: u32 = 0;
            let mut actual_sample_rate: u32 = 24000;

            // Use streaming session for true streaming
            let mut session = match model.synthesize_voice_clone_streaming(&text, &prompt, language, options) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(request_id = %rid3, error = %e, "Failed to create streaming session");
                    let _ = tx2.blocking_send(Ok(streaming::build_error_frame(
                        &format!("Failed to create streaming session: {}", e),
                    )));
                    return Err(e);
                }
            };

            // Stream chunks as they are generated
            while let Some(audio_result) = session.next() {
                match audio_result {
                    Ok(audio) => {
                        let pcm_bytes = streaming::samples_to_pcm_bytes(&audio.samples);
                        let sample_rate = audio.sample_rate as u32;
                        actual_sample_rate = sample_rate;
                        total_samples += audio.samples.len();

                        // Send audio chunk(s)
                        for chunk_data in pcm_bytes.chunks(STREAM_CHUNK_PCM_BYTES) {
                            let frame = streaming::build_audio_frame(chunk_index, sample_rate, chunk_data);
                            if tx2.blocking_send(Ok(frame)).is_err() {
                                tracing::warn!(request_id = %rid3, chunk = chunk_index, "Client disconnected");
                                return Ok(());
                            }
                        }
                        chunk_index += 1;
                    }
                    Err(e) => {
                        tracing::error!(request_id = %rid3, error = %e, "Streaming generation failed");
                        let _ = tx2.blocking_send(Ok(streaming::build_error_frame(
                            &format!("Generation failed: {}", e),
                        )));
                        return Err(e);
                    }
                }
            }

            let gen_ms = gen_start.elapsed().as_millis() as u64;
            let audio_duration_ms = (total_samples as f64 / actual_sample_rate as f64 * 1000.0) as u64;
            let rtf = if audio_duration_ms > 0 {
                gen_ms as f64 / audio_duration_ms as f64
            } else {
                0.0
            };

            tracing::info!(
                request_id = %rid3,
                gen_ms = gen_ms,
                audio_ms = audio_duration_ms,
                rtf = format!("{:.2}", rtf),
                samples = total_samples,
                chunks = chunk_index,
                "Generation complete"
            );

            // Send end frame
            let end_frame = streaming::build_end_frame(chunk_index);
            let _ = tx2.blocking_send(Ok(end_frame));

            Ok::<(), anyhow::Error>(())
        })
        .await;

        state_clone.decrement_queue().await;

        match result {
            Ok(Ok(())) => {
                tracing::info!(
                    request_id = %rid2,
                    total_ms = start.elapsed().as_millis() as u64,
                    "clone_stream_complete"
                );
            }
            Ok(Err(e)) => {
                tracing::error!(
                    request_id = %rid2,
                    error = %e,
                    total_ms = start.elapsed().as_millis() as u64,
                    "clone_stream_generation_failed"
                );
            }
            Err(e) => {
                tracing::error!(request_id = %rid2, error = %e, "clone_stream_task_panicked");
                let _ = tx
                    .send(Ok(streaming::build_error_frame("Internal error")))
                    .await;
            }
        }
    });

    // Return the streaming response
    let body = Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx));

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/octet-stream")
        .header("Transfer-Encoding", "chunked")
        .body(body)
        .unwrap()
}

/// Resolve the voice clone prompt data from cache, disk, or by extracting from audio.
/// Returns a SerializablePrompt which can be sent to a blocking thread.
async fn resolve_prompt_data(
    state: &Arc<AppState>,
    req: &CloneStreamRequest,
    request_id: &str,
) -> anyhow::Result<SerializablePrompt> {
    // 1. Try cache by embedding path (disabled - causes Metal resource accumulation)
    // if let Some(path) = &req.embedding_path {
    //     if let Some(cached) = state.get_cached_prompt(path).await {
    //         tracing::info!(request_id = %request_id, source = "cache", path = %path, "Prompt resolved");
    //         return Ok(cached);
    //     }
    // }

    // 2. Always load from disk (avoid caching GPU tensors)
    if let Some(path) = &req.embedding_path {
        let disk_path = Path::new(path);
        if disk_path.exists() {
            tracing::info!(request_id = %request_id, source = "disk", path = %path, "Prompt resolved");
            let serializable = SerializablePrompt::load(disk_path)?;
            // Don't cache - always reload from disk to avoid Metal resource issues
            return Ok(serializable);
        }
    }

    // 3. Extract from reference audio
    tracing::info!(
        request_id = %request_id,
        source = "extract",
        ref_audio = %req.ref_audio_path,
        "Extracting prompt from audio..."
    );

    let ref_audio_path = req.ref_audio_path.clone();
    let ref_text_owned = req.ref_text.clone();
    let state_clone = Arc::clone(state);

    let serializable = tokio::task::spawn_blocking(move || {
        let ref_audio = AudioBuffer::load(&ref_audio_path)?;
        let ref_text = ref_text_owned.as_deref().filter(|s| !s.trim().is_empty());
        let model = state_clone.model.lock().unwrap();
        let prompt = model.create_voice_clone_prompt(&ref_audio, ref_text)?;
        SerializablePrompt::from_prompt(&prompt, ref_text)
    })
    .await??;

    Ok(serializable)
}

// ── POST /cache/clear ──

pub async fn clear_cache(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let prev_size = state.cache_size().await;
    state.clear_cache().await;
    tracing::info!(cleared_entries = prev_size, "Prompt cache cleared");
    Json(serde_json::json!({ "status": "ok", "cleared": prev_size }))
}

// ── Helpers ──

fn parse_language(s: Option<&str>) -> Language {
    match s.map(|s| s.to_lowercase()).as_deref() {
        Some("en" | "english") => Language::English,
        Some("zh" | "chinese") => Language::Chinese,
        Some("ja" | "japanese") => Language::Japanese,
        Some("ko" | "korean") => Language::Korean,
        Some("de" | "german") => Language::German,
        Some("fr" | "french") => Language::French,
        Some("ru" | "russian") => Language::Russian,
        Some("pt" | "portuguese") => Language::Portuguese,
        Some("es" | "spanish") => Language::Spanish,
        Some("it" | "italian") => Language::Italian,
        // "auto" or unknown → default to Chinese (most common for Qwen3-TTS)
        _ => Language::Chinese,
    }
}

/// Truncate a string for preview logging.
fn truncate_str(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_chars).collect();
        format!("{}...", truncated)
    }
}
