//! TTS Server HTTP benchmark.
//!
//! Benchmarks the `/clone-stream` endpoint of a running tts-server instance.
//! Measures TTFB (time-to-first-audio), total generation time, RTF, and
//! per-chunk inter-arrival latency.
//!
//! Usage:
//! ```sh
//! # Start the server first:
//! ./target/release/tts-server --port 5001
//!
//! # Then run the benchmark:
//! cargo run --release -p tts-server --bin tts-bench -- \
//!     --server-url http://localhost:5001 \
//!     --ref-audio path/to/ref.wav \
//!     --ref-text "reference transcription" \
//!     --iterations 3 --warmup 1
//! ```

use std::time::{Duration, Instant};

use clap::Parser;
use reqwest::Client;
use serde_json::json;

// ── Binary frame protocol constants (must match tts-server/src/streaming.rs) ──

const MARKER_AUDIO: u32 = 0xFFFF_FFFE;
const MARKER_END: u32 = 0xFFFF_FFFD;
const MARKER_ERROR: u32 = 0xFFFF_FFFF;
const HEADER_SIZE: usize = 16; // 4 × u32 big-endian

// ── CLI ──

#[derive(Parser, Debug)]
#[command(name = "tts-bench", about = "TTS server HTTP benchmark")]
struct Args {
    /// Server URL (e.g. http://localhost:5001)
    #[arg(long, default_value = "http://localhost:5001")]
    server_url: String,

    /// Path to reference audio file for voice cloning
    #[arg(long)]
    ref_audio: String,

    /// Reference audio transcription text
    #[arg(long, default_value = "")]
    ref_text: String,

    /// Path to pre-computed embedding (optional, speeds up requests)
    #[arg(long)]
    embedding_path: Option<String>,

    /// Language code
    #[arg(long, default_value = "Auto")]
    language: String,

    /// Custom text to synthesize (overrides built-in corpus)
    #[arg(long)]
    text: Option<String>,

    /// Number of warmup iterations (not measured)
    #[arg(long, default_value_t = 1)]
    warmup: usize,

    /// Number of timed iterations
    #[arg(long, default_value_t = 3)]
    iterations: usize,
}

// ── Test corpus ──

fn test_corpus() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "short",
            "The quick brown fox jumps over the lazy dog near the river bank.",
        ),
        (
            "medium",
            "In a quiet village nestled between rolling hills and dense forests, \
             there lived an old clockmaker who spent his days repairing timepieces \
             from centuries past. His workshop, filled with the gentle ticking of \
             a hundred clocks, was a place where time itself seemed to slow down.",
        ),
        (
            "long",
            "The development of artificial intelligence has been one of the most \
             transformative technological advances of the twenty-first century. From \
             natural language processing to computer vision, machine learning models \
             have achieved remarkable performance across a wide range of tasks. Speech \
             synthesis, in particular, has seen dramatic improvements with the \
             introduction of neural network architectures that can generate \
             high-fidelity audio from text input. These systems learn complex \
             patterns of prosody, intonation, and rhythm from large datasets of \
             recorded speech, producing output that is increasingly difficult to \
             distinguish from natural human speech.",
        ),
    ]
}

// ── Result structs ──

#[allow(dead_code)]
#[derive(Debug)]
struct RunResult {
    ttfb_ms: f64,
    total_ms: f64,
    audio_duration_s: f64,
    rtf: f64,
    chunks: u32,
    total_pcm_bytes: usize,
    sample_rate: u32,
    chunk_latencies_ms: Vec<f64>,
}

#[derive(Debug)]
struct AggResult {
    label: String,
    text_len: usize,
    avg_ttfb_ms: f64,
    avg_total_ms: f64,
    avg_audio_s: f64,
    avg_rtf: f64,
    avg_chunks: f64,
    min_rtf: f64,
    max_rtf: f64,
}

// ── Streaming protocol parser ──

async fn run_clone_stream(
    client: &Client,
    server_url: &str,
    ref_audio: &str,
    ref_text: &str,
    text: &str,
    language: &str,
    embedding_path: Option<&str>,
) -> Result<RunResult, String> {
    let start = Instant::now();

    let mut body = json!({
        "ref_audio_path": ref_audio,
        "ref_text": ref_text,
        "text": text,
        "language": language,
    });
    if let Some(ep) = embedding_path {
        body["embedding_path"] = json!(ep);
    }

    let resp = client
        .post(format!("{}/clone-stream", server_url))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("Server error {}: {}", status, body_text));
    }

    // Parse binary frames as they arrive so TTFB is the first audio frame,
    // not the end of the response body.
    let mut resp = resp;
    let mut pending: Vec<u8> = Vec::new();
    let mut ttfb: Option<Duration> = None;
    let mut chunks: u32 = 0;
    let mut total_pcm_bytes: usize = 0;
    let mut sample_rate: u32 = 24000;
    let mut chunk_latencies_ms: Vec<f64> = Vec::new();
    let mut last_chunk_time = start;
    let mut ended = false;

    while !ended {
        let Some(bytes) = resp
            .chunk()
            .await
            .map_err(|e| format!("Failed to read response: {}", e))?
        else {
            break; // stream closed (possibly truncated)
        };
        pending.extend_from_slice(&bytes);

        let mut consumed = 0;
        while pending.len() - consumed >= HEADER_SIZE {
            let buffer = &pending[consumed..];
            let field0 = u32::from_be_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]);
            let field1 = u32::from_be_bytes([buffer[4], buffer[5], buffer[6], buffer[7]]);
            let field2 = u32::from_be_bytes([buffer[8], buffer[9], buffer[10], buffer[11]]);
            let field3 = u32::from_be_bytes([buffer[12], buffer[13], buffer[14], buffer[15]]);

            // Detect frame type from marker positions
            // Audio frame:  [chunkIndex][MARKER_AUDIO][sampleRate][dataLen]
            // End frame:    [MARKER_END][totalChunks][0][0]
            // Error frame:  [MARKER_ERROR][0][0][msgLen]

            if field0 == MARKER_END {
                // End-of-stream
                ended = true;
                break;
            }

            // Every other frame is a header followed by `field3` payload bytes
            let frame_size = HEADER_SIZE + field3 as usize;
            if buffer.len() < frame_size {
                break; // wait for the rest of the frame
            }

            if field0 == MARKER_ERROR {
                let msg = std::str::from_utf8(&buffer[HEADER_SIZE..frame_size])
                    .unwrap_or("(invalid utf8)");
                return Err(format!("Server error: {}", msg));
            }

            if field1 == MARKER_AUDIO {
                let now = Instant::now();
                if ttfb.is_none() {
                    ttfb = Some(now.duration_since(start));
                }
                chunk_latencies_ms
                    .push(now.duration_since(last_chunk_time).as_secs_f64() * 1000.0);
                last_chunk_time = now;

                sample_rate = field2;
                total_pcm_bytes += field3 as usize;
                chunks += 1;
            }
            // Unknown frames are skipped
            consumed += frame_size;
        }
        pending.drain(..consumed);
    }

    let total_duration = start.elapsed();
    let total_ms = total_duration.as_secs_f64() * 1000.0;
    let ttfb_ms = ttfb
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(total_ms);

    // Audio duration: PCM bytes / (sample_rate * 2 bytes per sample * 1 channel)
    let audio_duration_s = if sample_rate > 0 {
        total_pcm_bytes as f64 / (sample_rate as f64 * 2.0)
    } else {
        0.0
    };

    let rtf = if audio_duration_s > 0.0 {
        (total_ms / 1000.0) / audio_duration_s
    } else {
        0.0
    };

    Ok(RunResult {
        ttfb_ms,
        total_ms,
        audio_duration_s,
        rtf,
        chunks,
        total_pcm_bytes,
        sample_rate,
        chunk_latencies_ms,
    })
}

// ── Main ──

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    // Health check
    let client = Client::builder()
        .timeout(Duration::from_secs(600))
        .build()?;

    eprintln!("Checking server health at {} ...", args.server_url);
    let health = client
        .get(format!("{}/health", args.server_url))
        .send()
        .await;
    match health {
        Ok(r) if r.status().is_success() => eprintln!("Server is healthy."),
        Ok(r) => {
            eprintln!("Server returned status {}. Proceeding anyway.", r.status());
        }
        Err(e) => {
            eprintln!("ERROR: Cannot reach server: {}", e);
            eprintln!("Make sure tts-server is running on {}", args.server_url);
            std::process::exit(1);
        }
    }

    // Build test cases
    let test_cases: Vec<(String, String)> = if let Some(ref text) = args.text {
        vec![("custom".to_string(), text.clone())]
    } else {
        test_corpus()
            .into_iter()
            .map(|(label, text)| (label.to_string(), text.to_string()))
            .collect()
    };

    // Header
    eprintln!();
    eprintln!("╔══════════════════════════════════════════════════════════════════════╗");
    eprintln!("║                   TTS Server Benchmark                              ║");
    eprintln!("╠══════════════════════════════════════════════════════════════════════╣");
    eprintln!("║ Server:     {:<55}║", args.server_url);
    eprintln!("║ Ref audio:  {:<55}║", truncate(&args.ref_audio, 55));
    eprintln!("║ Warmup:     {:<55}║", args.warmup);
    eprintln!("║ Iterations: {:<55}║", args.iterations);
    eprintln!("╚══════════════════════════════════════════════════════════════════════╝");
    eprintln!();

    let mut results: Vec<AggResult> = Vec::new();

    for (label, text) in &test_cases {
        eprintln!("── {} ({} chars) ──", label, text.len());

        // Warmup
        for w in 0..args.warmup {
            eprint!("  warmup {}/{} ... ", w + 1, args.warmup);
            match run_clone_stream(
                &client,
                &args.server_url,
                &args.ref_audio,
                &args.ref_text,
                text,
                &args.language,
                args.embedding_path.as_deref(),
            )
            .await
            {
                Ok(r) => eprintln!("ok ({:.0}ms, RTF={:.2})", r.total_ms, r.rtf),
                Err(e) => eprintln!("FAILED: {}", e),
            }
        }

        // Timed iterations
        let mut runs: Vec<RunResult> = Vec::new();
        for i in 0..args.iterations {
            eprint!("  iter {}/{} ... ", i + 1, args.iterations);
            match run_clone_stream(
                &client,
                &args.server_url,
                &args.ref_audio,
                &args.ref_text,
                text,
                &args.language,
                args.embedding_path.as_deref(),
            )
            .await
            {
                Ok(r) => {
                    eprintln!(
                        "ok  TTFB={:.0}ms  total={:.0}ms  RTF={:.3}  audio={:.1}s  chunks={}",
                        r.ttfb_ms, r.total_ms, r.rtf, r.audio_duration_s, r.chunks
                    );
                    runs.push(r);
                }
                Err(e) => {
                    eprintln!("FAILED: {}", e);
                }
            }
        }

        if runs.is_empty() {
            eprintln!("  ⚠ All iterations failed, skipping.\n");
            continue;
        }

        let n = runs.len() as f64;
        let avg_ttfb = runs.iter().map(|r| r.ttfb_ms).sum::<f64>() / n;
        let avg_total = runs.iter().map(|r| r.total_ms).sum::<f64>() / n;
        let avg_audio = runs.iter().map(|r| r.audio_duration_s).sum::<f64>() / n;
        let avg_rtf = runs.iter().map(|r| r.rtf).sum::<f64>() / n;
        let avg_chunks = runs.iter().map(|r| r.chunks as f64).sum::<f64>() / n;
        let min_rtf = runs
            .iter()
            .map(|r| r.rtf)
            .fold(f64::INFINITY, f64::min);
        let max_rtf = runs
            .iter()
            .map(|r| r.rtf)
            .fold(f64::NEG_INFINITY, f64::max);

        results.push(AggResult {
            label: label.clone(),
            text_len: text.len(),
            avg_ttfb_ms: avg_ttfb,
            avg_total_ms: avg_total,
            avg_audio_s: avg_audio,
            avg_rtf,
            avg_chunks,
            min_rtf,
            max_rtf,
        });

        eprintln!();
    }

    // Summary table
    if !results.is_empty() {
        println!();
        println!("┌─────────┬───────┬──────────┬──────────┬──────────┬──────────┬────────┬─────────────┐");
        println!("│ Label   │ Chars │ TTFB(ms) │ Total(ms)│ Audio(s) │ Avg RTF  │ Chunks │ RTF range   │");
        println!("├─────────┼───────┼──────────┼──────────┼──────────┼──────────┼────────┼─────────────┤");
        for r in &results {
            println!(
                "│ {:<7} │ {:>5} │ {:>8.0} │ {:>8.0} │ {:>8.1} │ {:>8.3} │ {:>6.0} │ {:.3}-{:.3}  │",
                r.label,
                r.text_len,
                r.avg_ttfb_ms,
                r.avg_total_ms,
                r.avg_audio_s,
                r.avg_rtf,
                r.avg_chunks,
                r.min_rtf,
                r.max_rtf,
            );
        }
        println!("└─────────┴───────┴──────────┴──────────┴──────────┴──────────┴────────┴─────────────┘");
        println!();

        // RTF interpretation
        for r in &results {
            let speed_label = if r.avg_rtf < 1.0 {
                format!("{:.1}x faster than real-time", 1.0 / r.avg_rtf)
            } else {
                format!("{:.1}x slower than real-time", r.avg_rtf)
            };
            println!("  {} ({}ch): RTF={:.3} ({})", r.label, r.text_len, r.avg_rtf, speed_label);
        }
        println!();
    }

    Ok(())
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max - 3])
    }
}
