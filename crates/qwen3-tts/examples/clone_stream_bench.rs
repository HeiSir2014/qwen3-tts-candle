//! In-process ICL voice-clone streaming benchmark.
//!
//! Mirrors the mlx-audio streaming benchmark (same corpus, sampling params and
//! 0.8 s chunks) so RTF / TTFB are directly comparable, and prints a
//! per-phase breakdown (ms per 12 Hz frame) from a separate profiled run.
//!
//! ```sh
//! cargo run --release --features metal,hub --example clone_stream_bench -- \
//!     --ref-audio ref.wav --ref-text "reference transcript" [--save-dir out/]
//! ```

use anyhow::Result;
use qwen3_tts::{
    auto_device, AudioBuffer, Language, ModelPaths, Qwen3TTS, StreamingProfile, SynthesisOptions,
};
use std::time::Instant;

const MODEL_ID: &str = "Qwen/Qwen3-TTS-12Hz-0.6B-Base";
const WARMUP: usize = 1;
const ITERATIONS: usize = 3;
const CHUNK_FRAMES: usize = 10; // 0.8 s at 12.5 Hz, same as mlx streaming_interval=0.8

const CORPUS: &[(&str, &str)] = &[
    ("zh_short", "今天天气真好，我们出去走走吧。"),
    (
        "zh_long",
        "人工智能正在深刻改变我们的生活方式。从智能语音助手到自动驾驶汽车，从医疗诊断到金融分析，AI技术已经渗透到各个领域。未来，随着技术的不断进步，我们将看到更多令人惊叹的应用场景。",
    ),
    ("en_short", "The weather is beautiful today, let's go for a walk."),
    (
        "en_long",
        "Artificial intelligence is profoundly changing the way we live. From smart voice assistants to self-driving cars, from medical diagnosis to financial analysis, AI technology has permeated every field. In the future, as technology continues to advance, we will see even more amazing applications.",
    ),
];

struct RunResult {
    ttfb_ms: f64,
    total_ms: f64,
    audio_s: f64,
    chunks: usize,
    profile: Option<StreamingProfile>,
    audio: AudioBuffer,
}

fn arg_value(name: &str) -> Option<String> {
    std::env::args().skip_while(|a| a != name).nth(1)
}

fn run_once(
    model: &Qwen3TTS,
    ref_audio: &AudioBuffer,
    ref_text: &str,
    text: &str,
    profile: bool,
) -> Result<RunResult> {
    let options = SynthesisOptions {
        temperature: 0.9,
        top_k: 50,
        top_p: 0.9,
        repetition_penalty: 1.05,
        chunk_frames: CHUNK_FRAMES,
        ..Default::default()
    };
    // Prompt extraction is included in TTFB, as in mlx-audio's generate().
    let start = Instant::now();
    let prompt = model.create_voice_clone_prompt(ref_audio, Some(ref_text))?;
    let mut session =
        model.synthesize_voice_clone_streaming(text, &prompt, Language::Chinese, options)?;
    if profile {
        session.enable_profiling();
    }
    let mut ttfb_ms = None;
    let mut samples = Vec::new();
    let mut chunks = 0;
    for chunk in session.by_ref() {
        let chunk = chunk?;
        ttfb_ms.get_or_insert_with(|| start.elapsed().as_secs_f64() * 1000.0);
        samples.extend_from_slice(&chunk.samples);
        chunks += 1;
    }
    let total_ms = start.elapsed().as_secs_f64() * 1000.0;
    let audio = AudioBuffer::new(samples, 24000);
    Ok(RunResult {
        ttfb_ms: ttfb_ms.unwrap_or(total_ms),
        total_ms,
        audio_s: audio.duration() as f64,
        chunks,
        profile: session.profile().cloned(),
        audio,
    })
}

fn main() -> Result<()> {
    let ref_audio_path = arg_value("--ref-audio").expect("--ref-audio is required");
    let ref_text = arg_value("--ref-text").expect("--ref-text is required");
    let save_dir = arg_value("--save-dir");
    let labels: Option<Vec<String>> =
        arg_value("--labels").map(|s| s.split(',').map(str::to_string).collect());

    let device = auto_device()?;
    let t0 = Instant::now();
    let model = Qwen3TTS::from_paths(&ModelPaths::download(Some(MODEL_ID))?, device)?;
    println!("load_ms={:.0}", t0.elapsed().as_secs_f64() * 1000.0);
    let ref_audio = AudioBuffer::load(&ref_audio_path)?;

    for (label, text) in CORPUS {
        if labels
            .as_ref()
            .is_some_and(|l| !l.iter().any(|x| x == label))
        {
            continue;
        }
        for _ in 0..WARMUP {
            run_once(&model, &ref_audio, &ref_text, text, false)?;
        }
        let runs = (0..ITERATIONS)
            .map(|_| run_once(&model, &ref_audio, &ref_text, text, false))
            .collect::<Result<Vec<_>>>()?;
        let n = runs.len() as f64;
        let avg = |f: fn(&RunResult) -> f64| runs.iter().map(f).sum::<f64>() / n;
        println!(
            "{label}: rtf={:.3} ttfb={:.0}ms total={:.0}ms audio={:.2}s chunks={:.1}",
            avg(|r| r.total_ms / 1000.0 / r.audio_s),
            avg(|r| r.ttfb_ms),
            avg(|r| r.total_ms),
            avg(|r| r.audio_s),
            avg(|r| r.chunks as f64),
        );

        let profiled = run_once(&model, &ref_audio, &ref_text, text, true)?;
        if let Some(p) = &profiled.profile {
            let per_frame = |ms: f64| ms / p.frames.max(1) as f64;
            println!(
                "  profile: frames={} cp={:.2}ms/f talker={:.2}ms/f sample={:.2}ms/f \
                 decode={:.1}ms/chunk ({:.2}ms/f) ttfb={:.0}ms",
                p.frames,
                per_frame(p.code_predictor_ms),
                per_frame(p.talker_ms),
                per_frame(p.sampling_ms),
                p.decode_ms / p.decode_calls.max(1) as f64,
                per_frame(p.decode_ms),
                profiled.ttfb_ms,
            );
        }
        if let Some(dir) = &save_dir {
            let last = runs.last().unwrap_or(&profiled);
            last.audio.save(format!("{dir}/{label}.wav"))?;
        }
    }
    Ok(())
}
