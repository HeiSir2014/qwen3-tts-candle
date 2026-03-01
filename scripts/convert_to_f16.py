#!/usr/bin/env python3
"""Convert Qwen3-TTS model weights from BF16 to F16 safetensors.

Usage:
    python scripts/convert_to_f16.py --output ./models/qwen3-tts-f16

This downloads the official BF16 model from HuggingFace Hub (if not cached),
converts to F16, and saves locally. The Rust server can then load directly
from the local path without runtime conversion.
"""

import argparse
import os
import shutil
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file
from huggingface_hub import snapshot_download


TALKER_REPO = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
DECODER_REPO = "Qwen/Qwen3-TTS-Tokenizer-12Hz"
TOKENIZER_REPO = "Qwen/Qwen2-0.5B"


def convert_tensors(input_path: str, output_path: str, target_dtype=torch.float16):
    """Convert safetensors file to target dtype."""
    tensors = load_file(input_path)
    converted = {}
    skipped = 0
    for name, tensor in tensors.items():
        if tensor.is_floating_point():
            converted[name] = tensor.to(target_dtype)
        else:
            converted[name] = tensor  # keep int tensors as-is
            skipped += 1

    save_file(converted, output_path)
    return len(converted), skipped


def main():
    parser = argparse.ArgumentParser(description="Convert Qwen3-TTS to F16")
    parser.add_argument(
        "--output", "-o",
        type=str,
        default="./models/qwen3-tts-f16",
        help="Output directory for converted model",
    )
    parser.add_argument(
        "--keep-decoder-f32",
        action="store_true",
        default=True,
        help="Keep decoder weights in F32 (default: True, recommended for audio quality)",
    )
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Download / locate talker model
    print(f"Downloading {TALKER_REPO}...")
    talker_dir = snapshot_download(TALKER_REPO)
    print(f"  Cached at: {talker_dir}")

    # 2. Convert talker weights BF16 → F16
    src_weights = os.path.join(talker_dir, "model.safetensors")
    dst_weights = output_dir / "model.safetensors"
    print(f"Converting talker weights to F16...")
    n, s = convert_tensors(src_weights, str(dst_weights))
    print(f"  Converted {n} tensors ({s} non-float skipped) → {dst_weights}")

    # 3. Copy config.json
    src_config = os.path.join(talker_dir, "config.json")
    dst_config = output_dir / "config.json"
    if os.path.exists(src_config):
        shutil.copy2(src_config, dst_config)
        print(f"  Copied config.json")

    # 4. Copy tokenizer files
    tokenizer_dir = snapshot_download(TOKENIZER_REPO)
    src_tokenizer = os.path.join(tokenizer_dir, "tokenizer.json")
    dst_tokenizer = output_dir / "tokenizer.json"
    if os.path.exists(src_tokenizer):
        shutil.copy2(src_tokenizer, dst_tokenizer)
        print(f"  Copied tokenizer.json")

    # 5. Handle decoder (speech tokenizer)
    print(f"\nDownloading {DECODER_REPO}...")
    decoder_dir = snapshot_download(DECODER_REPO)
    src_decoder = os.path.join(decoder_dir, "model.safetensors")

    st_dir = output_dir / "speech_tokenizer"
    st_dir.mkdir(parents=True, exist_ok=True)
    dst_decoder = st_dir / "model.safetensors"

    if args.keep_decoder_f32:
        # Copy decoder as-is (F32)
        shutil.copy2(src_decoder, dst_decoder)
        print(f"  Kept decoder in F32 → {dst_decoder}")
    else:
        # Convert decoder F32 → F16
        n, s = convert_tensors(src_decoder, str(dst_decoder))
        print(f"  Converted decoder to F16: {n} tensors → {dst_decoder}")

    # Summary
    model_size = dst_weights.stat().st_size / (1024 * 1024)
    decoder_size = dst_decoder.stat().st_size / (1024 * 1024)
    print(f"\nDone! Model saved to: {output_dir}")
    print(f"  Talker weights: {model_size:.1f} MB (F16)")
    print(f"  Decoder weights: {decoder_size:.1f} MB ({'F32' if args.keep_decoder_f32 else 'F16'})")
    print(f"\nUsage:")
    print(f"  ./target/release/tts-server --model-path {output_dir}")


if __name__ == "__main__":
    main()
