"""Request audio: one WAV window (PCM16, mono, any rate) → 16 kHz float32.

Two limits are ARCHITECTURAL facts of Whisper, not configuration:

* 16 kHz — the feature extractor's sampling rate. A WAV at another rate is resampled here
  (band-limited, so content above the new Nyquist is removed rather than aliased); C-3
  accepts any rate.
* 30 s — the encoder's fixed input (3000 mel frames). vLLM does not split a longer clip
  for the engine API (vllm-project/vllm#15012), so a longer window would be silently cut.
  It is refused by name instead, judged on the SOURCE duration.

Error codes are the OpenAI route's (C-3): ``unsupported_audio`` · ``audio_too_long``.
"""

from __future__ import annotations

import io
import wave

import numpy as np
import numpy.typing as npt

SAMPLE_RATE = 16_000
MAX_WINDOW_SECONDS = 30.0
#: The highest source rate accepted (48 kHz covers every capture path in the fleet). It
#: bounds the largest legal upload, so the route can refuse a bigger one unread.
MAX_SAMPLE_RATE = 48_000
_BYTES_PER_SAMPLE = 2
_VOICED_FRAME_MS = 30


class AudioError(ValueError):
    """A request window this service will not decode; ``code`` names why."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def resample_to_16k(samples: npt.NDArray[np.float32], rate: int) -> npt.NDArray[np.float32]:
    """Band-limited (FFT) resampling to 16 kHz; a 16 kHz input is returned as is.

    Dependency-free on purpose (numpy only — the service imports on a Mac with no SciPy
    guarantee). A window is at most 30 s, so one FFT per request is cheap; the spectrum is
    truncated (downsampling) or zero-padded (upsampling), which is the ideal low-pass.
    """
    if rate == SAMPLE_RATE:
        return samples
    n_in = samples.shape[0]
    n_out = max(1, int(round(n_in * SAMPLE_RATE / rate)))
    spectrum = np.fft.rfft(samples.astype(np.float64))
    bins = n_out // 2 + 1
    resized = np.zeros(bins, dtype=np.complex128)
    keep = min(bins, spectrum.shape[0])
    resized[:keep] = spectrum[:keep]
    if n_out < n_in and n_out % 2 == 0:
        resized[-1] = resized[-1].real  # the new Nyquist bin of an even-length signal is real
    out: npt.NDArray[np.float64] = np.fft.irfft(resized, n_out) * (n_out / n_in)
    return out.astype(np.float32)


def decode_wav(data: bytes) -> tuple[npt.NDArray[np.float32], float]:
    """A PCM16 mono WAV (any rate) → ``(16 kHz float32 samples, source duration in s)``.

    Refuses by name (:class:`AudioError`) anything else, an empty file, or more than 30 s.
    """
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            channels = wav.getnchannels()
            width = wav.getsampwidth()
            rate = wav.getframerate()
            frames = wav.getnframes()
            raw = wav.readframes(frames)
    except (wave.Error, EOFError, ValueError) as exc:
        raise AudioError("unsupported_audio", f"file is not a PCM WAV ({exc})") from None
    if channels != 1 or width != _BYTES_PER_SAMPLE:
        raise AudioError(
            "unsupported_audio",
            f"file must be PCM16 mono WAV; got {channels} channel(s) of {width * 8}-bit samples",
        )
    if frames == 0 or rate <= 0 or not raw:
        raise AudioError("unsupported_audio", "file has no audio frames")
    if rate > MAX_SAMPLE_RATE:
        raise AudioError(
            "unsupported_audio", f"sample rate {rate} Hz is above the {MAX_SAMPLE_RATE} Hz maximum"
        )
    duration = frames / rate
    if duration > MAX_WINDOW_SECONDS:
        raise AudioError(
            "audio_too_long",
            f"audio is {duration:.2f}s; Whisper encodes at most {MAX_WINDOW_SECONDS:.0f}s "
            "(vllm-project/vllm#15012) — split it upstream",
        )
    pcm = np.frombuffer(raw[: frames * _BYTES_PER_SAMPLE], dtype="<i2")
    samples = (pcm.astype(np.float32) / 32768.0).astype(np.float32)
    return resample_to_16k(samples, rate), duration


def voiced_seconds(samples: npt.NDArray[np.float32], *, threshold_dbfs: float) -> float:
    """Seconds of audio in 30 ms frames whose RMS is at or above ``threshold_dbfs``.

    A crude energy gate, not a VAD: it only has to tell "there was sound here" from
    silence, for the truncation heuristic in :mod:`hope_vllm.truncation`.
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
