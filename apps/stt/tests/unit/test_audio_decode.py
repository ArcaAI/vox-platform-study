"""Unit tests for tolerant audio decoding (TASK-607).

Regression context: an OPPO/ColorOS phone recording appends a proprietary
``oppoMark//oppoMark`` trailer (ASCII waveform peaks + binary marker blocks)
AFTER the last MPEG frame. libsndfile's mpg123 backend tries to parse that
trailer as audio, fails to resync, and raises
``LibsndfileError: Unspecified internal error`` — failing a batch job whose
audio is perfectly intact.

The fixture below reproduces that byte layout from a synthesized tone, so the
regression is covered without shipping a PHI recording.
"""

import io
import shutil
import struct
import subprocess

import numpy as np
import pytest

from stt.core.exceptions import AudioCorruptedError
from stt.transcription.audio_decode import decode_audio

pytestmark = pytest.mark.unit

requires_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None,
    reason="ffmpeg not installed",
)

# Byte-for-byte the trailer observed on the failing upload: an ASCII peak
# array, the vendor marker, then binary marker blocks.
_OPPO_TRAILER = (
    b"oppoMark//oppoMark\xef\xbf\xb2"
    + b",".join(str(n).encode() for n in range(0, 14000, 7))
    + b"mark\x00\x007\xf0mark"
    + bytes(range(256)) * 4
)


def _sine_wav(duration: float = 2.0, sample_rate: int = 16000) -> bytes:
    """Build a minimal 16-bit PCM WAV of a 440 Hz tone."""
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    samples = (np.sin(2 * np.pi * 440 * t) * 0.5 * 32767).astype(np.int16)

    buf = io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + samples.nbytes))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16))
    buf.write(b"data")
    buf.write(struct.pack("<I", samples.nbytes))
    buf.write(samples.tobytes())
    return buf.getvalue()


@pytest.fixture(scope="module")
def clean_wav_bytes() -> bytes:
    return _sine_wav()


@pytest.fixture(scope="module")
def clean_mp3_bytes(clean_wav_bytes: bytes) -> bytes:
    """Encode the tone to MP3 (skips when ffmpeg is unavailable)."""
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not installed")
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", "pipe:0", "-f", "mp3", "pipe:1"],
        input=clean_wav_bytes,
        capture_output=True,
        check=True,
    )
    return proc.stdout


@pytest.fixture(scope="module")
def oppo_trailer_mp3_bytes(clean_mp3_bytes: bytes) -> bytes:
    """The regression fixture: valid MP3 + vendor trailer."""
    return clean_mp3_bytes + _OPPO_TRAILER


class TestDecodeAudio:
    """decode_audio() — the single entry point for uploaded audio."""

    def test_decodes_clean_wav_via_soundfile(self, clean_wav_bytes: bytes) -> None:
        samples, sample_rate = decode_audio(clean_wav_bytes)

        assert sample_rate == 16000
        assert samples.dtype == np.float32
        assert len(samples) == pytest.approx(32000, abs=1)
        assert np.abs(samples).max() > 0.4

    @requires_ffmpeg
    def test_decodes_clean_mp3(self, clean_mp3_bytes: bytes) -> None:
        samples, sample_rate = decode_audio(clean_mp3_bytes)

        assert sample_rate == 16000
        assert len(samples) / sample_rate == pytest.approx(2.0, abs=0.2)

    @requires_ffmpeg
    def test_decodes_mp3_with_vendor_trailer(self, oppo_trailer_mp3_bytes: bytes) -> None:
        """The exact failure from the OPPO upload — must not raise."""
        samples, sample_rate = decode_audio(oppo_trailer_mp3_bytes)

        assert sample_rate == 16000
        # The whole tone survives; the trailer contributes no samples.
        assert len(samples) / sample_rate == pytest.approx(2.0, abs=0.2)
        assert np.abs(samples).max() > 0.4

    @requires_ffmpeg
    def test_trailer_decode_matches_clean_decode(
        self, clean_mp3_bytes: bytes, oppo_trailer_mp3_bytes: bytes
    ) -> None:
        """Appending the trailer must not change the decoded audio."""
        clean, _ = decode_audio(clean_mp3_bytes)
        trailing, _ = decode_audio(oppo_trailer_mp3_bytes)

        shared = min(len(clean), len(trailing))
        assert shared > 0
        assert np.allclose(clean[:shared], trailing[:shared], atol=1e-6)

    def test_empty_input_raises_audio_corrupted(self) -> None:
        with pytest.raises(AudioCorruptedError):
            decode_audio(b"")

    def test_undecodable_bytes_raise_audio_corrupted(self) -> None:
        """Garbage must surface as a non-retryable, user-readable error."""
        with pytest.raises(AudioCorruptedError) as exc_info:
            decode_audio(b"this is not audio" * 1000)

        assert exc_info.value.error_code == "AUDIO_CORRUPTED"
        # The libsndfile/ffmpeg wording stays in details, not the user message.
        assert "Unspecified internal error" not in exc_info.value.message

    def test_raises_audio_corrupted_when_ffmpeg_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """No ffmpeg on PATH → a clear error, never a bare OSError."""
        monkeypatch.setattr("stt.transcription.audio_decode.shutil.which", lambda _: None)

        with pytest.raises(AudioCorruptedError):
            decode_audio(b"still not audio" * 1000)

    def test_stereo_input_keeps_channels(self) -> None:
        """Downmixing stays the preprocessor's job — decode must not do it."""
        import soundfile as sf

        stereo = np.stack(
            [np.linspace(-0.5, 0.5, 8000), np.linspace(0.5, -0.5, 8000)], axis=1
        ).astype(np.float32)
        buf = io.BytesIO()
        sf.write(buf, stereo, 16000, format="WAV", subtype="FLOAT")

        samples, sample_rate = decode_audio(buf.getvalue())

        assert sample_rate == 16000
        assert samples.shape == (8000, 2)


class TestPreprocessorIntegration:
    """AudioPreprocessor must inherit the tolerant decode path."""

    @requires_ffmpeg
    async def test_process_handles_vendor_trailer(self, oppo_trailer_mp3_bytes: bytes) -> None:
        from stt.pipeline.dto import DenoiseConfig, PreprocessingConfig, VadConfig
        from stt.transcription.preprocessing import AudioPreprocessor

        config = PreprocessingConfig(
            target_sample_rate=16000,
            normalize=True,
            vad=VadConfig(enabled=False),
            denoise=DenoiseConfig(enabled=False),
        )

        result = await AudioPreprocessor().process(
            audio_bytes=oppo_trailer_mp3_bytes, config=config
        )

        assert result.sample_rate == 16000
        assert result.duration_seconds == pytest.approx(2.0, abs=0.2)
