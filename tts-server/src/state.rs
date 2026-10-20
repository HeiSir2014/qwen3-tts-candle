use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use std::time::Instant;

use std::path::Path;

use anyhow::Result;
use candle_core::Device;
use qwen3_tts::{
    auto_device, device_info, AudioBuffer, Language, ModelPaths, Qwen3TTS, Speaker,
    SynthesisOptions,
};
use tokio::sync::Mutex as TokioMutex;

use crate::embedding::SerializablePrompt;

/// Shared application state accessible from all route handlers.
///
/// The model uses a std::sync::Mutex because inference is CPU/GPU-bound
/// and must be held across blocking operations (spawn_blocking).
pub struct AppState {
    /// The loaded TTS model. Uses std Mutex so it can be locked from blocking contexts.
    pub model: StdMutex<Qwen3TTS>,
    /// Optional CustomVoice model serving the preset speakers.
    pub custom_voice: Option<StdMutex<Qwen3TTS>>,
    /// Cache of pre-computed voice clone prompts, keyed by embedding file path.
    pub prompt_cache: TokioMutex<HashMap<String, SerializablePrompt>>,
    /// Number of requests currently waiting for the model lock.
    pub queue_size: TokioMutex<u32>,
    /// Server startup time for uptime reporting.
    pub started_at: Instant,
    /// Device description string (e.g. "Metal", "CUDA", "CPU").
    pub device_label: String,
}

const MAX_CACHE_SIZE: usize = 50;

impl AppState {
    /// Load the model(s) and create a new AppState.
    ///
    /// `custom_voice_path` is the CustomVoice model for preset speakers;
    /// `None` disables `/speakers` and `/tts-stream`.
    pub fn new(
        model_path: &str,
        custom_voice_path: Option<&str>,
        device_str: &str,
    ) -> Result<Self> {
        let device = if device_str == "auto" {
            auto_device()?
        } else {
            qwen3_tts::parse_device(device_str)?
        };

        let label = device_info(&device);
        tracing::info!("Device: {}", label);

        let model = load_model(model_path, device.clone())?;
        // Warmup: run a short synthesis to JIT-compile Metal/CUDA kernels
        // so the first real request doesn't pay the compilation cost.
        tracing::info!("Warming up model (short synthesis)...");
        match model.synthesize("warmup", None) {
            Ok(audio) => {
                tracing::info!("Warmup complete");
                if model.supports_voice_cloning() {
                    match warm_up_clone(&model, &audio) {
                        Ok(()) => tracing::info!("Voice clone warmup complete"),
                        Err(e) => tracing::warn!("Voice clone warmup failed (non-fatal): {}", e),
                    }
                }
            }
            Err(e) => tracing::warn!("Warmup synthesis failed (non-fatal): {}", e),
        }

        let custom_voice = match custom_voice_path {
            Some(path) => {
                let cv = load_model(path, device)?;
                if !cv.supports_preset_speakers() {
                    anyhow::bail!("{} is not a CustomVoice model", path);
                }
                match cv.synthesize_with_voice("warmup", Speaker::Serena, Language::Chinese, None) {
                    Ok(_) => tracing::info!("CustomVoice warmup complete"),
                    Err(e) => tracing::warn!("CustomVoice warmup failed (non-fatal): {}", e),
                }
                Some(StdMutex::new(cv))
            }
            None => None,
        };

        Ok(Self {
            model: StdMutex::new(model),
            custom_voice,
            prompt_cache: TokioMutex::new(HashMap::new()),
            queue_size: TokioMutex::new(0),
            started_at: Instant::now(),
            device_label: label,
        })
    }

    /// Insert a prompt into the cache, evicting oldest if at capacity.
    pub async fn cache_prompt(&self, key: String, serializable: SerializablePrompt) {
        let mut cache = self.prompt_cache.lock().await;
        if cache.len() >= MAX_CACHE_SIZE {
            if let Some(k) = cache.keys().next().cloned() {
                cache.remove(&k);
            }
        }
        cache.insert(key, serializable);
    }

    pub async fn cache_size(&self) -> usize {
        self.prompt_cache.lock().await.len()
    }

    pub async fn clear_cache(&self) {
        self.prompt_cache.lock().await.clear();
    }

    pub async fn increment_queue(&self) {
        let mut q = self.queue_size.lock().await;
        *q += 1;
    }

    pub async fn decrement_queue(&self) {
        let mut q = self.queue_size.lock().await;
        *q = q.saturating_sub(1);
    }

    pub async fn get_queue_size(&self) -> u32 {
        *self.queue_size.lock().await
    }
}

/// Run the /clone-stream path once (prompt extraction + first streamed chunk)
/// so the first real request doesn't pay its kernel compilation: the plain
/// warmup synthesis never touches the speaker/speech encoders or the ICL
/// decoder priming. `reference` is the warmup synthesis output.
fn warm_up_clone(model: &Qwen3TTS, reference: &AudioBuffer) -> Result<()> {
    let prompt = model.create_voice_clone_prompt(reference, Some("warmup"))?;
    let mut session = model.synthesize_voice_clone_streaming(
        "warmup",
        &prompt,
        Language::Chinese,
        SynthesisOptions::default(),
    )?;
    session.next().transpose()?;
    Ok(())
}

/// Load a model from a local weights directory or a HuggingFace model ID.
fn load_model(model_path: &str, device: Device) -> Result<Qwen3TTS> {
    tracing::info!("Loading model from: {}", model_path);
    let model = if Path::new(model_path).join("model.safetensors").exists() {
        tracing::info!("Loading from local path...");
        Qwen3TTS::from_pretrained(model_path, device)?
    } else {
        tracing::info!("Downloading model from HuggingFace Hub...");
        let paths = ModelPaths::download(Some(model_path))?;
        Qwen3TTS::from_paths(&paths, device)?
    };
    tracing::info!("Model loaded successfully");
    Ok(model)
}
