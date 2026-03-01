mod embedding;
mod routes;
mod server;
mod state;
mod streaming;

use std::sync::Arc;

use clap::Parser;
use tokio::signal;
use tracing_appender::rolling;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[derive(Parser)]
#[command(name = "tts-server", about = "Qwen3-TTS inference server")]
struct Args {
    /// Port to listen on.
    #[arg(long, default_value = "5001")]
    port: u16,

    /// Path to model weights directory (local or HuggingFace model ID).
    #[arg(long, default_value = "Qwen/Qwen3-TTS-12Hz-0.6B-Base")]
    model_path: String,

    /// Device to use: auto, cpu, cuda, cuda:N, metal.
    #[arg(long, default_value = "auto")]
    device: String,

    /// Log directory for file output (default: ./logs).
    #[arg(long, default_value = "logs")]
    log_dir: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    // ── Logging: console + rolling file ──
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "tts_server=info,qwen3_tts=info,tower_http=info".into());

    // Rolling daily log file, kept up to 5 days
    let file_appender = rolling::daily(&args.log_dir, "tts-server.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::registry()
        .with(filter)
        // Console layer: human-readable with ANSI colors
        .with(
            fmt::layer()
                .with_target(true)
                .with_thread_ids(false)
                .with_ansi(true),
        )
        // File layer: structured, no ANSI escape codes
        .with(
            fmt::layer()
                .with_target(true)
                .with_thread_ids(true)
                .with_ansi(false)
                .with_writer(non_blocking),
        )
        .init();

    tracing::info!("Qwen3-TTS Server starting...");
    tracing::info!(model = %args.model_path, device = %args.device, port = args.port, log_dir = %args.log_dir);

    // Load model (this can take a while)
    let state = Arc::new(state::AppState::new(&args.model_path, &args.device)?);

    // Build router
    let app = server::build_router(state);

    // Start server
    let addr = format!("0.0.0.0:{}", args.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("TTS server listening on http://{}", addr);

    // Serve with graceful shutdown
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("TTS server shut down.");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("Shutdown signal received, stopping...");
}
