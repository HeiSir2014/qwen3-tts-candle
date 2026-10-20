"""Single-thread MLX inference engine for Qwen3-TTS.

MLX GPU streams are bound to the thread that created them, so model loading
and every generation run on one worker thread. HTTP handlers submit jobs and
consume audio chunks through per-job queues; this also serializes GPU work.
"""

import logging
import os
import queue
import threading
from typing import Callable, Iterator, Optional

import mlx.core as mx
import numpy as np
from mlx_audio.tts.utils import load_model
from mlx_audio.utils import load_audio

log = logging.getLogger("mlx-engine")

SAMPLE_RATE = 24000
# 0.8 s chunks, matching tts-server's default chunk_frames=10 at 12.5 Hz.
STREAM_INTERVAL_S = 0.8
# Same sampling defaults as tts-server/src/routes.rs.
SAMPLING = dict(temperature=0.9, top_k=50, top_p=0.9, repetition_penalty=1.05)

# Runaway guard: quantized checkpoints occasionally never sample EOS. Cap codec
# frames (12.5 per second) relative to text length instead of the 2048 default.
FRAMES_PER_CHAR = 6
MIN_MAX_FRAMES = 125
MAX_MAX_FRAMES = 2048

PROMPT_FORMAT_VERSION = 1

# Official CustomVoice speaker descriptions (QwenLM/Qwen3-TTS README).
SPEAKER_INFO = {
    "vivian": ("Vivian", "Bright, slightly edgy young female voice. (Chinese)"),
    "serena": ("Serena", "Warm, gentle young female voice. (Chinese)"),
    "uncle_fu": ("Uncle_Fu", "Seasoned male voice with a low, mellow timbre. (Chinese)"),
    "dylan": ("Dylan", "Youthful Beijing male voice with a clear, natural timbre. (Beijing dialect)"),
    "eric": ("Eric", "Lively Chengdu male voice with a slightly husky brightness. (Sichuan dialect)"),
    "ryan": ("Ryan", "Dynamic male voice with strong rhythmic drive. (English)"),
    "aiden": ("Aiden", "Sunny American male voice with a clear midrange. (English)"),
    "ono_anna": ("Ono_Anna", "Playful Japanese female voice with a light, nimble timbre. (Japanese)"),
    "sohee": ("Sohee", "Warm Korean female voice with rich emotion. (Korean)"),
}

_DONE = object()


class EngineError(Exception):
    """A request the engine rejects (bad input or unsupported feature)."""


def max_frames_for(text: str) -> int:
    return max(MIN_MAX_FRAMES, min(MAX_MAX_FRAMES, len(text) * FRAMES_PER_CHAR))


def save_prompt(output_path: str, audio: np.ndarray, ref_text: str) -> None:
    """Write the normalized reference audio + transcript atomically."""
    tmp_path = f"{output_path}.tmp"
    with open(tmp_path, "wb") as f:
        np.savez(f, version=PROMPT_FORMAT_VERSION, audio=audio, ref_text=ref_text)
    os.replace(tmp_path, output_path)


def load_prompt(path: str) -> tuple[np.ndarray, str]:
    with np.load(path) as data:
        if int(data["version"]) != PROMPT_FORMAT_VERSION:
            raise EngineError(f"Unsupported prompt version in {path}")
        return data["audio"], str(data["ref_text"])


class _Job:
    def __init__(self, work: Callable[["_Job"], None]):
        self.work = work
        self.results: queue.Queue = queue.Queue()
        self.cancelled = threading.Event()


class Engine:
    def __init__(self, base_model_id: str, custom_voice_model_id: Optional[str]):
        self.base_model_id = base_model_id
        self.custom_voice_model_id = custom_voice_model_id
        self._base = None
        self._custom_voice = None
        self._jobs: queue.Queue = queue.Queue()
        self._active = 0
        self._ready = threading.Event()
        self._load_error: Optional[BaseException] = None
        threading.Thread(target=self._run, name="mlx-engine", daemon=True).start()

    # ── lifecycle ──

    def wait_ready(self) -> None:
        self._ready.wait()
        if self._load_error:
            raise RuntimeError("Model loading failed") from self._load_error

    def queue_size(self) -> int:
        return self._jobs.qsize() + self._active

    def _run(self) -> None:
        try:
            log.info("Loading base model %s", self.base_model_id)
            self._base = load_model(self.base_model_id)
            if self.custom_voice_model_id:
                log.info("Loading CustomVoice model %s", self.custom_voice_model_id)
                self._custom_voice = load_model(self.custom_voice_model_id)
            for _ in self._base.generate(text="Hello.", lang_code="english", **SAMPLING):
                pass
            log.info("Models ready")
        except BaseException as e:  # surfaced to the main thread by wait_ready()
            self._load_error = e
            return
        finally:
            self._ready.set()

        while True:
            job = self._jobs.get()
            self._active = 1
            try:
                if not job.cancelled.is_set():
                    job.work(job)
            except Exception as e:
                job.results.put(e)
            finally:
                job.results.put(_DONE)
                self._active = 0
                mx.clear_cache()

    def _submit(self, work: Callable[[_Job], None]) -> Iterator:
        job = _Job(work)
        self._jobs.put(job)
        try:
            while (item := job.results.get()) is not _DONE:
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            job.cancelled.set()  # client gone or finished: stop generating

    def speakers(self) -> list[dict]:
        if self._custom_voice is None:
            return []
        result = []
        for speaker_id in self._custom_voice.get_supported_speakers():
            name, description = SPEAKER_INFO.get(speaker_id, (speaker_id, ""))
            result.append({"id": speaker_id, "name": name, "description": description})
        return result

    # ── operations (`work` bodies run on the engine thread) ──

    def prepare_prompt(self, ref_audio_path: str, ref_text: str, output_path: str) -> None:
        def work(job: _Job) -> None:
            audio = np.array(load_audio(ref_audio_path, sample_rate=SAMPLE_RATE), dtype=np.float32)
            if audio.size == 0:
                raise EngineError(f"Reference audio is empty: {ref_audio_path}")
            save_prompt(output_path, audio, ref_text)

        for _ in self._submit(work):
            pass

    def clone_stream(
        self,
        text: str,
        language: str,
        ref_audio_path: str,
        ref_text: str,
        embedding_path: Optional[str],
    ) -> Iterator[np.ndarray]:
        def work(job: _Job) -> None:
            if embedding_path and os.path.exists(embedding_path):
                audio, _ = load_prompt(embedding_path)
            else:
                audio = load_audio(ref_audio_path, sample_rate=SAMPLE_RATE)
            # Empty transcript → x-vector only mode; otherwise ICL cloning.
            self._stream(job, self._base, text, language,
                         ref_audio=mx.array(audio), ref_text=ref_text.strip() or None)

        return self._submit(work)

    def tts_stream(self, voice: str, text: str, language: str) -> Iterator[np.ndarray]:
        if self._custom_voice is None:
            raise EngineError("No CustomVoice model configured (set TTS_MLX_CV_MODEL)")
        if voice not in self._custom_voice.get_supported_speakers():
            raise EngineError(f"Unknown voice: {voice}")

        def work(job: _Job) -> None:
            self._stream(job, self._custom_voice, text, language, voice=voice)

        return self._submit(work)

    @staticmethod
    def _stream(job: _Job, model, text: str, language: str, **voice_kwargs) -> None:
        for result in model.generate(
            text=text,
            lang_code=language.lower(),
            stream=True,
            streaming_interval=STREAM_INTERVAL_S,
            max_tokens=max_frames_for(text),
            **voice_kwargs,
            **SAMPLING,
        ):
            if job.cancelled.is_set():
                return
            job.results.put(np.array(result.audio, dtype=np.float32))
