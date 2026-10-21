# qwen3-tts-candle

Pure Rust inference implementation for [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) (Alibaba's text-to-speech model), powered by [Candle](https://github.com/huggingface/candle) ML framework.

## Features

- **Pure Rust** — no Python runtime or C++ dependencies required
- **Multi-platform GPU** — Apple Silicon (Metal), NVIDIA CUDA, Flash Attention 2
- **CPU fallback** — with optional MKL / Accelerate BLAS acceleration
- **Voice cloning** — ECAPA-TDNN speaker encoder extracts voice embeddings from reference audio
- **Streaming synthesis** — binary frame protocol delivers ~0.8s audio chunks incrementally
- **HTTP server** — production-ready Axum server with health checks, prompt caching, and request tracing
- **Voice Recorder UI** — React + Bun full-stack app for recording, managing speaker profiles, and voice clone jobs
- **Model auto-detection** — automatically identifies model variant (0.6B / 1.7B, Base / CustomVoice / VoiceDesign) from `config.json`
- **HuggingFace Hub** — downloads model weights automatically if not found locally

## Architecture

Three-stage TTS pipeline:

```text
Text ──→ [TalkerModel] ──→ semantic tokens (1 per frame)
              │
              ▼
         [CodePredictor] ──→ 15 acoustic codes per semantic token
              │
              ▼
         [Decoder12Hz] ──→ 24kHz mono WAV audio
```

| Stage | Description |
|-------|-------------|
| **TalkerModel** | 28-layer transformer with GQA + MRoPE. 0.6B (hidden=1024) or 1.7B (hidden=2048). |
| **CodePredictor** | 5-layer autoregressive decoder (hidden=1024). Generates 15 acoustic codes per semantic frame. |
| **Decoder12Hz** | ConvNeXt + transposed convolution. 16-codebook residual VQ → 24kHz f32 PCM. |

## Supported Models

| HuggingFace ID | Size | Description |
| --- | --- | --- |
| `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | 1.8 GB | Voice cloning via speaker encoder |
| `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` | 1.8 GB | 9 preset speakers |
| `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | 3.9 GB | Voice cloning (larger model) |
| `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | 3.9 GB | 9 preset speakers (larger model) |
| `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | 3.8 GB | Text-described voice design |

## Quick Start

### Prerequisites

- **Rust** (1.75+) — [rustup.rs](https://rustup.rs), for the default `rust` backend
- **uv** (optional) — [docs.astral.sh/uv](https://docs.astral.sh/uv/), only for the `mlx` backend (Apple Silicon)
- **Bun** (optional, for Voice Recorder UI) — [bun.sh](https://bun.sh)

### Prebuilt binaries

[Releases](https://github.com/HeiSir2014/qwen3-tts-candle/releases) ship `tts-server` and `generate_audio`:

| Asset | Platform | Requirements |
|-------|----------|--------------|
| `*-macos-arm64-metal.tar.gz` | macOS, Apple Silicon | macOS 14+ |
| `*-windows-x64-cpu.zip` | Windows x64 | none |
| `*-windows-x64-cuda.zip` | Windows x64, NVIDIA GPU (sm_80+) | NVIDIA driver 580+ and CUDA 13 runtime (cuBLAS, cuRAND) on `PATH` |

The macOS binaries are not notarized. If downloaded through a browser, clear the quarantine flag:

```bash
xattr -d com.apple.quarantine tts-server generate_audio
```

Verify a download against its build provenance:

```bash
gh attestation verify qwen3-tts-candle-<version>-<label>.zip --repo HeiSir2014/qwen3-tts-candle
```

To cut a release, bump `version` in `tts-server/Cargo.toml` (commit the refreshed `Cargo.lock` too), then push a matching tag
(`git tag v0.1.0 && git push origin v0.1.0`). A tag with a suffix (`v0.2.0-rc.1`) is published as a prerelease.

### One-command startup (server + UI)

```bash
git clone https://github.com/HeiSir2014/qwen3-tts-candle.git
cd qwen3-tts-candle
bash scripts/start.sh
```

This will:

1. Prepare the TTS backend: a release build of the Rust server for `rust`, or `uv sync` for `mlx`
2. Install Bun dependencies for the Voice Recorder UI
3. Start the Bun server (auto-launches the selected TTS server)

Once running:

- **TTS Server**: <http://localhost:5001>
- **Voice Recorder UI**: <https://localhost:3000>

Model weights are downloaded automatically from HuggingFace Hub on first run.

### TTS backends

The Voice Recorder talks to one of two interchangeable servers on port 5001.
Both implement the same HTTP API and binary streaming protocol.

| Backend | Server | Platform | Notes |
|---------|--------|----------|-------|
| `rust` | `tts-server/` (Candle) | Metal / CUDA / CPU | Default everywhere |
| `mlx` | `mlx-server/` (Python, [mlx-audio](https://github.com/Blaizzy/mlx-audio)) | Apple Silicon | Optional; can load quantized (4/8-bit) MLX checkpoints |

Both serve voice cloning and the 9 CustomVoice preset speakers.

Select it in `voice-recorder/.env`:

```bash
TTS_BACKEND=rust           # or mlx
# TTS_RUST_CV_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice           (default; a local dir works too, empty disables preset voices)
# TTS_MLX_MODEL=mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16          (default)
# TTS_MLX_CV_MODEL=mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit (default; empty disables preset voices)
```

Measured on Apple Silicon (0.6B Base, ICL voice clone, streaming 0.8 s chunks,
`cargo run --release --features metal,hub --example clone_stream_bench`):
Candle 0.11 Metal BF16 RTF ≈ 0.54–0.61 (TTFB ≈ 0.57–0.61 s) vs mlx bf16
RTF ≈ 0.65–0.70 (TTFB ≈ 0.57–0.60 s). 4-bit MLX checkpoints are ~2x faster
again but occasionally fail to emit EOS, so mlx-server caps generation length
relative to the text.

### Run TTS server only

```bash
# Build
cargo build --release -p tts-server

# Run (model auto-downloads from HuggingFace Hub)
./target/release/tts-server

# Or specify options
./target/release/tts-server \
  --port 5001 \
  --model-path Qwen/Qwen3-TTS-12Hz-0.6B-Base \
  --device auto
```

CLI flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `5001` | HTTP listen port |
| `--model-path` | `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | Local path or HuggingFace model ID |
| `--custom-voice-model` | `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` | Model for the preset speakers; `""` disables them |
| `--device` | `auto` | `auto`, `cpu`, `cuda`, `cuda:N`, `metal` |
| `--log-dir` | `logs` | Rolling daily log output directory |

### Use as a Rust library

Add to your `Cargo.toml`:

```toml
[dependencies]
qwen3-tts = { path = "crates/qwen3-tts", features = ["metal"] }
```

```rust
use qwen3_tts::{Qwen3TTS, SynthesisOptions, auto_device};

// Load model (auto-detected from config.json)
let device = auto_device()?;
let model = Qwen3TTS::from_pretrained("path/to/model", device)?;

// Synthesize speech
let audio = model.synthesize("Hello, world!", None)?;
audio.save("output.wav")?;

// With custom options
let options = SynthesisOptions {
    temperature: 0.8,
    top_k: 30,
    ..Default::default()
};
let audio = model.synthesize("Custom settings!", Some(options))?;
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Model status, backend, queue size, uptime |
| `POST` | `/extract-embedding` | Precompute the voice prompt from reference audio (`.bin` for rust, `.npz` for mlx) |
| `POST` | `/clone-stream` | Voice clone with streaming binary frame response |
| `POST` | `/cache/clear` | Clear in-memory prompt cache (rust only) |
| `GET` | `/speakers` | CustomVoice preset speakers (empty when disabled) |
| `POST` | `/tts-stream` | Preset-speaker synthesis `{voice, text, language, instruct?}`, same frame protocol; `instruct` (e.g. "用特别愤怒的语气说") needs the 1.7B CustomVoice model |

### Streaming protocol

`/clone-stream` returns chunked binary frames (big-endian u32):

```text
[chunkIndex: u32] [marker: u32] [sampleRate: u32] [dataLen: u32] [data bytes]
```

| Marker | Value | Meaning |
|--------|-------|---------|
| `AUDIO` | `0xFFFFFFFE` | Audio chunk (~0.8s of 24kHz 16-bit PCM) |
| `END` | `0xFFFFFFFD` | End of stream |
| `ERROR` | `0xFFFFFFFF` | Error with message payload |

## Platform Support

| Platform | Feature Flag | Compute dtype |
|----------|-------------|---------------|
| CPU (any) | `cpu` (default) | F32 |
| macOS Apple Silicon | `metal` | BF16 (talker + code_predictor), F32 (decoder) |
| macOS Accelerate | `accelerate` | F32 + BLAS |
| Intel MKL | `mkl` | F32 + BLAS |
| NVIDIA CUDA | `cuda` | BF16 |
| NVIDIA Flash Attention | `flash-attn` | BF16 + FA2 |

Build with a specific backend:

```bash
# Apple Silicon (default for tts-server)
cargo build --release -p tts-server

# NVIDIA GPU
cargo build --release -p tts-server --no-default-features --features cuda

# CPU only
cargo build --release -p tts-server --no-default-features --features cpu
```

Windows + CUDA 13.x: build from a Visual Studio developer shell. candle-kernels
0.11 needs MSVC's conforming preprocessor there
([huggingface/candle#3686](https://github.com/huggingface/candle/issues/3686)):

```powershell
$env:CUDA_COMPUTE_CAP = "86"   # your GPU's compute capability, e.g. 86 for RTX 30xx
$env:NVCC_PREPEND_FLAGS = "-Xcompiler /Zc:preprocessor"
cargo build --release -p tts-server --no-default-features --features cuda
```

The fused SnakeBeta/SwiGLU kernels and the SDPA prefill path are Metal-only;
other backends fall back to plain tensor ops. The algorithmic speedups
(incremental streaming decoder, host-side sampling, fused RoPE, single prefill)
apply to every backend.

## Project Structure

```text
qwen3-tts-candle/
├── crates/qwen3-tts/       # Core inference library
│   └── src/
│       ├── lib.rs           # Public API: Qwen3TTS, StreamingSession
│       ├── models/          # TalkerModel, CodePredictor, Decoder12Hz, SpeakerEncoder
│       ├── generation/      # Sampling (top-k/p, temperature, repetition penalty)
│       ├── audio/           # WAV I/O, mel spectrogram, resampling
│       └── tokenizer/       # Text tokenizer (Qwen2 vocab, 151K tokens)
├── tts-server/              # Axum HTTP server
│   └── src/
│       ├── main.rs          # CLI entry point
│       ├── server.rs        # Router + middleware
│       ├── routes.rs        # API handlers
│       ├── streaming.rs     # Binary frame streaming protocol
│       └── embedding.rs     # Speaker embedding serialization
├── mlx-server/              # MLX TTS server (Python, Apple Silicon)
│   ├── server.py            # Flask API, same protocol as tts-server
│   ├── engine.py            # Single-thread MLX inference engine
│   └── protocol.py          # Binary frame encoding
├── voice-recorder/          # Bun + React voice clone studio
│   ├── src/                 # Bun backend (HTTPS, SSE, TTS bridge)
│   └── ui/                  # React SPA (profiles, recording, clone lab)
└── scripts/
    ├── start.sh             # One-command build + run
    └── convert_to_f16.py    # BF16 → F16 weight conversion
```

## BF16 → F16 Weight Conversion

To halve model disk size / VRAM usage:

```bash
pip install torch safetensors huggingface_hub
python scripts/convert_to_f16.py --keep-decoder-f32
```

## License

This project provides a Rust inference implementation for the Qwen3-TTS model. Please refer to [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) for model license terms.
