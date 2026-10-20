//! Batch VoiceDesign: one model load, many text-described voices.
//!
//! Reads a JSON list of `{ "id", "instruct", "text", "language" }` and writes
//! `<out-dir>/<id>_s<seed>.wav` for every seed, so several candidate voices
//! per description can be compared. VoiceDesign samples a new voice each
//! run; keep the one you like and reuse it as a clone reference.
//!
//! ```sh
//! cargo run --release --features cuda --example voice_design_batch -- \
//!     --model-dir models/Qwen3-TTS-12Hz-1.7B-VoiceDesign \
//!     --roles roles.json --out-dir out [--seeds 1,2]
//! ```

use anyhow::{Context, Result};
use qwen3_tts::{auto_device, device_info, Language, Qwen3TTS, SynthesisOptions};
use serde::Deserialize;
use std::path::PathBuf;
use std::time::Instant;

/// Upper bound on generated audio per line (12.5 frames/s → ~60 s).
const MAX_FRAMES: usize = 750;

#[derive(Deserialize)]
struct Role {
    id: String,
    instruct: String,
    text: String,
    language: String,
}

fn arg_value(name: &str) -> Option<String> {
    std::env::args().skip_while(|a| a != name).nth(1)
}

fn main() -> Result<()> {
    let model_dir = arg_value("--model-dir").context("--model-dir is required")?;
    let roles_path = arg_value("--roles").context("--roles is required")?;
    let out_dir = PathBuf::from(arg_value("--out-dir").unwrap_or_else(|| "voice_design".into()));
    let seeds: Vec<u64> = arg_value("--seeds")
        .unwrap_or_else(|| "1".into())
        .split(',')
        .map(|s| s.trim().parse())
        .collect::<Result<_, _>>()
        .context("--seeds must be a comma-separated list of integers")?;

    let roles: Vec<Role> = serde_json::from_str(
        &std::fs::read_to_string(&roles_path).with_context(|| format!("reading {roles_path}"))?,
    )?;
    std::fs::create_dir_all(&out_dir)?;

    let device = auto_device()?;
    println!("device: {}", device_info(&device));
    let load_start = Instant::now();
    let model = Qwen3TTS::from_pretrained(&model_dir, device)?;
    println!("load_ms={}", load_start.elapsed().as_millis());
    if !model.supports_voice_design() {
        anyhow::bail!("{model_dir} is not a VoiceDesign model");
    }

    for role in &roles {
        let language: Language = role.language.parse()?;
        for &seed in &seeds {
            // Official generation_config.json defaults for the 1.7B models.
            let options = SynthesisOptions {
                max_length: MAX_FRAMES,
                temperature: 0.9,
                top_k: 50,
                top_p: 1.0,
                repetition_penalty: 1.05,
                seed: Some(seed),
                ..Default::default()
            };
            let start = Instant::now();
            let audio =
                model.synthesize_voice_design(&role.text, &role.instruct, language, Some(options))?;
            let elapsed = start.elapsed().as_secs_f32();
            let path = out_dir.join(format!("{}_s{seed}.wav", role.id));
            audio.save(&path)?;
            println!(
                "{} seed={seed} audio={:.2}s rtf={:.2} -> {}",
                role.id,
                audio.duration(),
                elapsed / audio.duration().max(1e-3),
                path.display()
            );
        }
    }
    Ok(())
}
