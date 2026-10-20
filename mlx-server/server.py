"""MLX TTS server: drop-in replacement for tts-server (Rust) on Apple Silicon.

Speaks the same HTTP API and binary streaming protocol as tts-server, plus
CustomVoice preset speakers:
  GET  /health
  POST /extract-embedding  {ref_audio_path, ref_text, output_path}
  POST /clone-stream       {ref_audio_path, ref_text, text, language, embedding_path?}
  GET  /speakers
  POST /tts-stream         {voice, text, language}
"""

import argparse
import logging
import os
import sys
import time
from typing import Iterator

import numpy as np
from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import HTTPException

import protocol
from engine import SAMPLE_RATE, Engine, EngineError

DEFAULT_BASE_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16"
DEFAULT_CUSTOM_VOICE_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"

log = logging.getLogger("mlx-server")
app = Flask(__name__)
engine: Engine
started_at = time.monotonic()


def error(status: int, message: str) -> Response:
    response = jsonify({"error": message})
    response.status_code = status
    return response


def json_body(*required: str) -> dict:
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise EngineError("JSON body required")
    missing = [key for key in required if not body.get(key)]
    if missing:
        raise EngineError(f"Missing required fields: {', '.join(missing)}")
    return body


@app.errorhandler(EngineError)
def handle_engine_error(e: EngineError) -> Response:
    return error(400, str(e))


@app.errorhandler(Exception)
def handle_unexpected_error(e: Exception):
    if isinstance(e, HTTPException):
        return e
    log.exception("request_failed request_id=%s", request_id())
    return error(500, f"{type(e).__name__}: {e}")


def stream_frames(chunks: Iterator[np.ndarray], request_id: str) -> Response:
    def generate() -> Iterator[bytes]:
        started = time.perf_counter()
        index = 0
        total_samples = 0
        try:
            for samples in chunks:
                if index == 0:
                    log.info("first_chunk request_id=%s ttfb_ms=%.0f", request_id,
                             (time.perf_counter() - started) * 1000)
                yield protocol.audio_frame(index, SAMPLE_RATE, samples)
                total_samples += samples.size
                index += 1
            yield protocol.end_frame(index)
            elapsed = time.perf_counter() - started
            audio_s = total_samples / SAMPLE_RATE
            log.info("stream_complete request_id=%s chunks=%d audio_s=%.2f gen_ms=%.0f rtf=%.2f",
                     request_id, index, audio_s, elapsed * 1000, elapsed / audio_s if audio_s else 0)
        except Exception as e:
            log.exception("stream_failed request_id=%s", request_id)
            yield protocol.error_frame(f"Generation failed: {e}")

    return Response(generate(), mimetype="application/octet-stream")


def request_id() -> str:
    return request.headers.get("X-Request-Id", "-")


@app.get("/health")
def health() -> Response:
    return jsonify({
        "model_loaded": True,
        "backend": "mlx",
        "model": engine.base_model_id,
        "custom_voice_model": engine.custom_voice_model_id,
        "queue_size": engine.queue_size(),
        "uptime_s": int(time.monotonic() - started_at),
    })


@app.post("/extract-embedding")
def extract_embedding() -> Response:
    body = json_body("ref_audio_path", "output_path")
    if not os.path.exists(body["ref_audio_path"]):
        return error(404, f"Reference audio not found: {body['ref_audio_path']}")
    started = time.perf_counter()
    engine.prepare_prompt(body["ref_audio_path"], body.get("ref_text") or "", body["output_path"])
    log.info("prompt_saved request_id=%s path=%s ms=%.0f", request_id(), body["output_path"],
             (time.perf_counter() - started) * 1000)
    return jsonify({"status": "ok", "output_path": body["output_path"]})


@app.post("/clone-stream")
def clone_stream() -> Response:
    body = json_body("ref_audio_path", "text")
    if not os.path.exists(body["ref_audio_path"]):
        return error(404, f"Reference audio not found: {body['ref_audio_path']}")
    log.info("clone_stream_start request_id=%s text_len=%d has_embedding=%s",
             request_id(), len(body["text"]), bool(body.get("embedding_path")))
    chunks = engine.clone_stream(
        text=body["text"],
        language=body.get("language") or "Auto",
        ref_audio_path=body["ref_audio_path"],
        ref_text=body.get("ref_text") or "",
        embedding_path=body.get("embedding_path"),
    )
    return stream_frames(chunks, request_id())


@app.get("/speakers")
def speakers() -> Response:
    return jsonify(engine.speakers())


@app.post("/tts-stream")
def tts_stream() -> Response:
    body = json_body("voice", "text")
    log.info("tts_stream_start request_id=%s voice=%s text_len=%d",
             request_id(), body["voice"], len(body["text"]))
    chunks = engine.tts_stream(body["voice"], body["text"], body.get("language") or "Auto")
    return stream_frames(chunks, request_id())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=5001)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s %(levelname)s [%(name)s] %(message)s")

    global engine
    engine = Engine(
        base_model_id=os.environ.get("TTS_MLX_MODEL") or DEFAULT_BASE_MODEL,
        custom_voice_model_id=os.environ.get("TTS_MLX_CV_MODEL", DEFAULT_CUSTOM_VOICE_MODEL) or None,
    )
    engine.wait_ready()
    log.info("MLX TTS server listening on http://127.0.0.1:%d", args.port)
    app.run(host="127.0.0.1", port=args.port, threaded=True)


if __name__ == "__main__":
    main()
