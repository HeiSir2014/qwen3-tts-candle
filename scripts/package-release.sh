#!/bin/bash
# Package the release binaries from target/release into dist/.
# Usage: scripts/package-release.sh <version> <label>   e.g. 0.1.0 macos-arm64-metal
set -euo pipefail

VERSION="$1"
LABEL="$2"

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="qwen3-tts-candle-$VERSION-$LABEL"
STAGE="$PROJECT_ROOT/dist/$NAME"

EXE=""
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) EXE=".exe" ;;
esac

rm -rf "$STAGE"
mkdir -p "$STAGE"
for bin in tts-server generate_audio; do
  cp "$PROJECT_ROOT/target/release/$bin$EXE" "$STAGE/"
done
cp "$PROJECT_ROOT/README.md" "$STAGE/"

cd "$PROJECT_ROOT/dist"
if [ -n "$EXE" ]; then
  7z a -tzip -bso0 "$NAME.zip" "$NAME"
  echo "$PROJECT_ROOT/dist/$NAME.zip"
else
  tar -czf "$NAME.tar.gz" "$NAME"
  echo "$PROJECT_ROOT/dist/$NAME.tar.gz"
fi
