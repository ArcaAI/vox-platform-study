"""Audio post-processing for local engines.

Local models emit float32 samples at their native rate; this module resamples to
the 24 kHz service standard (Phase 0 finding: Indic Parler is 44.1 kHz) and
encodes to PCM s16le / WAV / MP3. numpy + soxr are ``[local]``-extra deps, so this
module is only imported by the local providers (never on a cloud-only install).
"""

from __future__ import annotations

import struct

import numpy as np
import soxr


def resample(samples: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Resample float samples; no-op when rates match."""
    if src_rate == dst_rate:
        return samples
    return soxr.resample(samples, src_rate, dst_rate)


def float_to_pcm16(samples: np.ndarray) -> bytes:
    """Clip to [-1, 1] and pack as little-endian signed 16-bit PCM."""
    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


def encode_pcm(samples: np.ndarray, src_rate: int, dst_rate: int) -> bytes:
    """Resample to dst_rate and return PCM s16le bytes."""
    return float_to_pcm16(resample(samples, src_rate, dst_rate))


def pcm16_to_wav(pcm: bytes, sample_rate: int, channels: int = 1) -> bytes:
    """Wrap PCM s16le in a RIFF/WAVE header (for batch/download responses)."""
    byte_rate = sample_rate * channels * 2
    block_align = channels * 2
    data_len = len(pcm)
    header = b"RIFF" + struct.pack("<I", 36 + data_len) + b"WAVE"
    header += b"fmt " + struct.pack(
        "<IHHIIHH", 16, 1, channels, sample_rate, byte_rate, block_align, 16
    )
    header += b"data" + struct.pack("<I", data_len)
    return header + pcm


def pcm16_to_mp3(pcm: bytes, sample_rate: int, channels: int = 1) -> bytes:
    """Encode PCM s16le to MP3 (lazily imports lameenc — a ``[local]`` dep)."""
    import lameenc

    encoder = lameenc.Encoder()
    encoder.set_bit_rate(48)
    encoder.set_in_sample_rate(sample_rate)
    encoder.set_channels(channels)
    encoder.set_quality(2)
    return bytes(encoder.encode(pcm)) + bytes(encoder.flush())
