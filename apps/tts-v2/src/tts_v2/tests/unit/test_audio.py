"""TDD tests for audio post-processing utilities."""

from __future__ import annotations

import struct

import numpy as np
import pytest

from tts_v2.core.audio import (
    encode_pcm,
    float_to_pcm16,
    pcm16_to_wav,
    resample,
)


def test_float_to_pcm16_length() -> None:
    assert len(float_to_pcm16(np.zeros(100, dtype=np.float32))) == 200  # 2 bytes/sample


def test_float_to_pcm16_clips_to_int16_range() -> None:
    data = float_to_pcm16(np.array([2.0, -2.0], dtype=np.float32))
    lo, hi = struct.unpack("<2h", data)
    assert lo == 32767 and hi == -32767


def test_resample_downsamples_44k_to_24k() -> None:
    out = resample(np.zeros(44100, dtype=np.float32), 44100, 24000)  # 1 s
    assert abs(len(out) - 24000) < 100


def test_resample_noop_when_rates_match() -> None:
    assert len(resample(np.zeros(10, dtype=np.float32), 24000, 24000)) == 10


def test_encode_pcm_resamples_and_packs() -> None:
    pcm = encode_pcm(np.zeros(44100, dtype=np.float32), 44100, 24000)
    assert abs(len(pcm) // 2 - 24000) < 100


def test_wav_header_shape() -> None:
    pcm = b"\x00\x00" * 10
    wav = pcm16_to_wav(pcm, 24000)
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"
    assert len(wav) == 44 + len(pcm)


def test_mp3_encode_smoke() -> None:
    pytest.importorskip("lameenc")
    from tts_v2.core.audio import pcm16_to_mp3

    out = pcm16_to_mp3(b"\x00\x00" * 2400, 24000)
    assert isinstance(out, bytes) and len(out) > 0
