#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Qwen3-TTS Candle ==="
echo ""

# 1. Build Rust TTS server (release mode)
echo "[1/3] Building Rust TTS server..."
cd "$PROJECT_ROOT"
cargo build --release -p tts-server
echo "  ✓ Build complete"

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
echo "  The Bun server will auto-start the Rust TTS server."
echo "  Rust TTS: http://localhost:5001"
echo "  Web UI:   https://localhost:3000"
echo ""

cd "$PROJECT_ROOT/voice-recorder"
exec bun run src/server.ts
