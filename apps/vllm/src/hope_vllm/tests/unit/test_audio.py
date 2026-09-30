"""Request audio: a PCM16 mono WAV at any rate → 16 kHz float32, window limit, voiced time."""

from __future__ import annotations

import io
import wave

import numpy as np
import pytest

from hope_vllm.audio import (
    MAX_WINDOW_SECONDS,
    SAMPLE_RATE,
    AudioError,
    decode_wav,
    resample_to_16k,
    voiced_seconds,
)
from hope_vllm.tests.conftest import wav_bytes


def raw_wav(frames: np.ndarray, rate: int = SAMPLE_RATE) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(frames.astype("<i2").tobytes())
    return buffer.getvalue()


def test_decodes_pcm16_le_to_float32_in_unit_range() -> None:
    samples, duration = decode_wav(raw_wav(np.array([0, 16384, -32768, 32767])))
    assert samples.dtype == np.float32
    np.testing.assert_allclose(samples, [0.0, 0.5, -1.0, 32767 / 32768], rtol=1e-6)
    assert duration == pytest.approx(4 / SAMPLE_RATE)


def test_a_seven_second_window_has_seven_seconds_of_samples() -> None:
    samples, duration = decode_wav(wav_bytes(7.0))
    assert samples.shape == (7 * SAMPLE_RATE,)
    assert duration == pytest.approx(7.0)


@pytest.mark.parametrize("rate", [8_000, 22_050, 44_100, 48_000])
def test_any_rate_is_resampled_to_16k_keeping_duration_and_pitch(rate: int) -> None:
    samples, duration = decode_wav(wav_bytes(2.0, rate=rate, freq_hz=440.0))
    assert duration == pytest.approx(2.0, abs=1e-3)
    assert samples.dtype == np.float32
    assert samples.shape == (32_000,)
    spectrum = np.abs(np.fft.rfft(samples))
    peak_hz = np.argmax(spectrum) * SAMPLE_RATE / samples.shape[0]
    assert peak_hz == pytest.approx(440.0, abs=2.0)


def test_16k_is_passed_through_untouched() -> None:
    samples = np.linspace(-0.5, 0.5, 100, dtype=np.float32)
    assert resample_to_16k(samples, SAMPLE_RATE) is samples


def test_content_above_the_new_nyquist_is_removed_not_aliased() -> None:
    """A 12 kHz tone at 48 kHz cannot exist at 16 kHz; it must vanish, not fold to 4 kHz."""
    samples, _ = decode_wav(wav_bytes(1.0, rate=48_000, freq_hz=12_000.0))
    assert float(np.max(np.abs(samples))) < 1e-3


@pytest.mark.parametrize(
    "data",
    [
        b"not a wav",
        b"",
        wav_bytes(1.0, channels=2),
        wav_bytes(1.0, sampwidth=1),
        wav_bytes(1.0, sampwidth=4),
        wav_bytes(0.0),
    ],
)
def test_anything_but_non_empty_pcm16_mono_wav_is_unsupported(data: bytes) -> None:
    with pytest.raises(AudioError) as exc:
        decode_wav(data)
    assert exc.value.code == "unsupported_audio"


def test_rejects_a_window_longer_than_whisper_can_encode() -> None:
    """vllm#15012: Whisper's encoder takes at most 30 s; a longer window must never be cut silently."""
    assert MAX_WINDOW_SECONDS == 30.0
    with pytest.raises(AudioError) as exc:
        decode_wav(wav_bytes(30.5))
    assert exc.value.code == "audio_too_long"


def test_the_limit_is_judged_on_the_source_duration_at_any_rate() -> None:
    with pytest.raises(AudioError):
        decode_wav(wav_bytes(31.0, rate=8_000))


def test_exactly_thirty_seconds_is_accepted() -> None:
    samples, _ = decode_wav(wav_bytes(30.0))
    assert samples.shape == (30 * SAMPLE_RATE,)


def test_voiced_seconds_counts_only_frames_above_the_threshold() -> None:
    tone, _ = decode_wav(wav_bytes(2.0, amplitude=0.3))
    silence = np.zeros(3 * SAMPLE_RATE, dtype=np.float32)
    samples = np.concatenate([tone, silence])
    assert voiced_seconds(samples, threshold_dbfs=-40.0) == pytest.approx(2.0, abs=0.05)


def test_silence_has_no_voiced_time() -> None:
    assert voiced_seconds(np.zeros(SAMPLE_RATE, dtype=np.float32), threshold_dbfs=-40.0) == 0.0
