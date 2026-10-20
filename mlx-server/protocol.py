"""Binary frame protocol shared with tts-server (Rust) and voice-recorder.

Every frame is a 16-byte header of four big-endian u32 followed by a payload:
  audio: [chunk_index, MARKER_AUDIO, sample_rate, len] + int16 LE PCM
  end:   [MARKER_END, total_chunks, 0, 0]
  error: [MARKER_ERROR, 0, 0, len] + UTF-8 message
"""

import struct

import numpy as np

MARKER_AUDIO = 0xFFFF_FFFE
MARKER_END = 0xFFFF_FFFD
MARKER_ERROR = 0xFFFF_FFFF

_HEADER = struct.Struct(">IIII")
_INT16_MAX = 32767.0


def audio_frame(chunk_index: int, sample_rate: int, samples: np.ndarray) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * _INT16_MAX).astype("<i2").tobytes()
    return _HEADER.pack(chunk_index, MARKER_AUDIO, sample_rate, len(pcm)) + pcm


def end_frame(total_chunks: int) -> bytes:
    return _HEADER.pack(MARKER_END, total_chunks, 0, 0)


def error_frame(message: str) -> bytes:
    data = message.encode("utf-8")
    return _HEADER.pack(MARKER_ERROR, 0, 0, len(data)) + data
