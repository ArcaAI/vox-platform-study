"""Request audio: base64 PCM16 LE mono 16 kHz → float32, window limits, voiced time."""

from __future__ import annotations

import base64

import numpy as np
import pytest

from hope_vllm.audio import (
    MAX_WINDOW_SECONDS,
    SAMPLE_RATE,
    AudioError,
    decode_pcm16_b64,
    voiced_seconds,
)
from hope_vllm.tests.conftest import pcm16_b64


def test_decodes_pcm16_le_to_float32_in_unit_range() -> None:
    raw = np.array([0, 16384, -32768, 32767], dtype="<i2").tobytes()
    samples = decode_pcm16_b64(base64.b64encode(raw).decode())
    assert samples.dtype == np.float32
    np.testing.assert_allclose(samples, [0.0, 0.5, -1.0, 32767 / 32768], rtol=1e-6)


def test_seven_second_window_has_seven_seconds_of_samples() -> None:
    samples = decode_pcm16_b64(pcm16_b64(7.0))
    assert samples.shape == (7 * SAMPLE_RATE,)


@pytest.mark.parametrize(
    ("data", "code"),
    [
        ("not base64 !!", "AUDIO_NOT_BASE64"),
        ("", "AUDIO_EMPTY"),
        (base64.b64encode(b"\x00\x01\x02").decode(), "AUDIO_ODD_BYTE_LENGTH"),
    ],
)
def test_rejects_malformed_audio_by_name(data: str, code: str) -> None:
    with pytest.raises(AudioError) as exc:
        decode_pcm16_b64(data)
    assert exc.value.code == code


def test_rejects_a_window_longer_than_whisper_can_encode() -> None:
    """vllm#15012: Whisper's encoder takes at most 30 s; a longer window must never be cut silently."""
    assert MAX_WINDOW_SECONDS == 30.0
    with pytest.raises(AudioError) as exc:
        decode_pcm16_b64(pcm16_b64(30.5))
    assert exc.value.code == "WINDOW_TOO_LONG"


def test_exactly_thirty_seconds_is_accepted() -> None:
    assert decode_pcm16_b64(pcm16_b64(30.0)).shape == (30 * SAMPLE_RATE,)


def test_voiced_seconds_counts_only_frames_above_the_threshold() -> None:
    tone = decode_pcm16_b64(pcm16_b64(2.0, amplitude=0.3))
    silence = np.zeros(3 * SAMPLE_RATE, dtype=np.float32)
    samples = np.concatenate([tone, silence])
    assert voiced_seconds(samples, threshold_dbfs=-40.0) == pytest.approx(2.0, abs=0.05)


def test_silence_has_no_voiced_time() -> None:
    assert voiced_seconds(np.zeros(SAMPLE_RATE, dtype=np.float32), threshold_dbfs=-40.0) == 0.0
