#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Same resolution as voice-recorder/src/tts-bridge.ts: env, then .env, then platform.
ENV_FILE="$PROJECT_ROOT/voice-recorder/.env"
if [ -z "$TTS_BACKEND" ] && [ -f "$ENV_FILE" ]; then
  TTS_BACKEND="$(grep -E '^TTS_BACKEND=' "$ENV_FILE" | tail -1 | cut -d= -f2)"
fi
if [ -z "$TTS_BACKEND" ]; then
  [ "$(uname -s)" = "Darwin" ] && TTS_BACKEND=mlx || TTS_BACKEND=rust
fi

echo "=== Qwen3-TTS Candle (backend: $TTS_BACKEND) ==="
echo ""

# 1. Prepare the TTS backend
if [ "$TTS_BACKEND" = "mlx" ]; then
  echo "[1/3] Syncing MLX TTS server environment..."
  command -v uv >/dev/null || { echo "  ✗ uv is required for the mlx backend: https://docs.astral.sh/uv/"; exit 1; }
  uv sync --directory "$PROJECT_ROOT/mlx-server"
  echo "  ✓ Environment ready"
else
  echo "[1/3] Building Rust TTS server..."
  cd "$PROJECT_ROOT"
  cargo build --release -p tts-server
  echo "  ✓ Build complete"
fi

# 2. Install Bun dependencies
echo "[2/3] Installing Bun dependencies..."
cd "$PROJECT_ROOT/voice-recorder"
bun install --frozen-lockfile 2>/dev/null || bun install
cd "$PROJECT_ROOT/voice-recorder/ui"
bun install --frozen-lockfile 2>/dev/null || bun install
echo "  ✓ Dependencies installed"

# 3. Start servers
echo "[3/3] Starting servers..."
echo ""
echo "  The Bun server will auto-start the $TTS_BACKEND TTS server."
echo "  TTS server: http://localhost:5001"
echo "  Web UI:     https://localhost:3000"
echo ""

cd "$PROJECT_ROOT/voice-recorder"
export TTS_BACKEND
exec bun run src/server.ts
