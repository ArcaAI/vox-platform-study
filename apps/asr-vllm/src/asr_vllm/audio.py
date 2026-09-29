"""Request audio: one window of PCM16 LE mono 16 kHz, carried base64 in the JSON body.

Two limits are ARCHITECTURAL facts of Whisper, not configuration:

* 16 kHz — the feature extractor's sampling rate; the request declares it and anything
  else is refused rather than resampled here (resampling is the caller's front end).
* 30 s — the encoder's fixed input (3000 mel frames). vLLM does not split a longer clip
  for the engine API (vllm-project/vllm#15012), so a longer window would be silently cut.
  It is refused by name instead.
"""

from __future__ import annotations

import base64
import binascii

import numpy as np
import numpy.typing as npt

SAMPLE_RATE = 16_000
MAX_WINDOW_SECONDS = 30.0
_BYTES_PER_SAMPLE = 2
_VOICED_FRAME_MS = 30


class AudioError(ValueError):
    """A request window this service will not decode; ``code`` names why."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def decode_pcm16_b64(data: str) -> npt.NDArray[np.float32]:
    """Base64 PCM16 LE mono → float32 in [-1, 1), refusing anything malformed or too long."""
    if not data:
        raise AudioError("AUDIO_EMPTY", "audio_b64 is empty")
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise AudioError("AUDIO_NOT_BASE64", "audio_b64 is not valid base64") from None
    if not raw:
        raise AudioError("AUDIO_EMPTY", "audio_b64 decodes to zero bytes")
    if len(raw) % _BYTES_PER_SAMPLE:
        raise AudioError("AUDIO_ODD_BYTE_LENGTH", "PCM16 audio must be an even number of bytes")
    seconds = len(raw) / (_BYTES_PER_SAMPLE * SAMPLE_RATE)
    if seconds > MAX_WINDOW_SECONDS:
        raise AudioError(
            "WINDOW_TOO_LONG",
            f"window is {seconds:.2f}s; Whisper encodes at most {MAX_WINDOW_SECONDS:.0f}s "
            "(vllm-project/vllm#15012) — split it upstream",
        )
    pcm = np.frombuffer(raw, dtype="<i2")
    return (pcm.astype(np.float32) / 32768.0).astype(np.float32)


def voiced_seconds(samples: npt.NDArray[np.float32], *, threshold_dbfs: float) -> float:
    """Seconds of audio in 30 ms frames whose RMS is at or above ``threshold_dbfs``.

    A crude energy gate, not a VAD: it only has to tell "there was sound here" from
    silence, for the truncation heuristic in :mod:`asr_vllm.truncation`.
    """
    frame = SAMPLE_RATE * _VOICED_FRAME_MS // 1000
    usable = (samples.shape[0] // frame) * frame
    if usable == 0:
        return 0.0
    frames = samples[:usable].reshape(-1, frame).astype(np.float64)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    threshold = 10.0 ** (threshold_dbfs / 20.0)
    voiced = int(np.count_nonzero(rms >= threshold))
    return voiced * _VOICED_FRAME_MS / 1000.0
