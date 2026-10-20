import struct
import tempfile
import unittest
from pathlib import Path

import numpy as np

import protocol
from engine import (MAX_MAX_FRAMES, MIN_MAX_FRAMES, PROMPT_FORMAT_VERSION, EngineError,
                    load_prompt, max_frames_for, save_prompt)


class ProtocolTest(unittest.TestCase):
    def test_audio_frame_layout(self):
        frame = protocol.audio_frame(3, 24000, np.array([0.0, 1.0, -1.0, 2.0], dtype=np.float32))
        self.assertEqual(struct.unpack(">IIII", frame[:16]), (3, protocol.MARKER_AUDIO, 24000, 8))
        self.assertEqual(np.frombuffer(frame[16:], dtype="<i2").tolist(), [0, 32767, -32767, 32767])

    def test_end_frame_carries_total(self):
        self.assertEqual(struct.unpack(">IIII", protocol.end_frame(7)), (protocol.MARKER_END, 7, 0, 0))

    def test_error_frame_payload(self):
        frame = protocol.error_frame("坏了")
        header = struct.unpack(">IIII", frame[:16])
        self.assertEqual(header[0], protocol.MARKER_ERROR)
        self.assertEqual(frame[16:16 + header[3]].decode("utf-8"), "坏了")


class EngineHelpersTest(unittest.TestCase):
    def test_max_frames_is_bounded(self):
        self.assertEqual(max_frames_for("hi"), MIN_MAX_FRAMES)
        self.assertEqual(max_frames_for("x" * 10_000), MAX_MAX_FRAMES)

    def test_prompt_round_trip(self):
        audio = np.linspace(-1, 1, 480, dtype=np.float32)
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "rec.npz")
            save_prompt(path, audio, "参考文本")
            loaded_audio, ref_text = load_prompt(path)
        np.testing.assert_array_equal(loaded_audio, audio)
        self.assertEqual(ref_text, "参考文本")

    def test_prompt_version_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "rec.npz")
            np.savez(path, version=PROMPT_FORMAT_VERSION + 1, audio=np.zeros(1), ref_text="")
            with self.assertRaises(EngineError):
                load_prompt(path)


if __name__ == "__main__":
    unittest.main()
