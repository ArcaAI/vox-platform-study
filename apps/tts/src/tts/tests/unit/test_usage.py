"""TDD tests for TTS usage-metering primitives.

Character counting is Unicode CODE POINTS (frozen contract §3/README §3): a
CJK/Indic character counts as 1, and an astral-plane emoji (outside the BMP)
also counts as 1 — never inflated the way UTF-16 code-unit counting would.

Audio-seconds derivation reuses the RTF byte math already used for the
``tts_rtf`` metric (``routing/router.py``): PCM is raw s16le mono, so
``bytes / (2 * sample_rate)``; WAV carries the same PCM payload behind a fixed
44-byte header; MP3 is a compressed, variable-bitrate format and duration is
NOT derivable from a byte count alone.
"""

from __future__ import annotations

from tts.core.usage import compute_audio_seconds, count_characters
from tts.providers.base import AudioFormat


class TestCountCharacters:
    def test_ascii(self) -> None:
        assert count_characters("Hello.") == 6

    def test_malayalam_code_points(self) -> None:
        # "നമസ്കാരം" (Malayalam "namaskaram") — each visual glyph may be
        # composed of multiple Unicode code points (base + vowel signs); the
        # contract counts CODE POINTS, not grapheme clusters or bytes.
        text = "നമസ്കാരം"
        assert count_characters(text) == len(text)
        assert count_characters(text) > 0

    def test_emoji_astral_plane_counts_as_one(self) -> None:
        # U+1F600 GRINNING FACE is outside the BMP. Python 3 str already
        # stores actual code points (PEP 393), so len() == 1 here — this test
        # pins that behavior against a future PEP 393 assumption change.
        assert count_characters("\U0001f600") == 1

    def test_mixed_text_with_emoji_and_sse_like_markup(self) -> None:
        # SSML-ish input is just text to the counter — no tag-stripping, no
        # double counting. Every code point (including '<', '>', '/') counts.
        text = "<speak>Hi \U0001f600</speak>"
        assert count_characters(text) == len(text)

    def test_empty_string(self) -> None:
        assert count_characters("") == 0


class TestComputeAudioSeconds:
    def test_pcm_s16le_mono(self) -> None:
        # 2 bytes/sample, mono, 24000 Hz -> 48000 bytes == 1.0s
        assert compute_audio_seconds(AudioFormat.PCM, 48_000, 24_000) == 1.0

    def test_pcm_zero_bytes_is_none(self) -> None:
        assert compute_audio_seconds(AudioFormat.PCM, 0, 24_000) is None

    def test_wav_subtracts_44_byte_header(self) -> None:
        # 44-byte RIFF/WAVE header + 48000 bytes of s16le PCM payload == 1.0s
        assert compute_audio_seconds(AudioFormat.WAV, 48_044, 24_000) == 1.0

    def test_wav_header_only_is_none(self) -> None:
        assert compute_audio_seconds(AudioFormat.WAV, 44, 24_000) is None

    def test_mp3_not_derivable_from_byte_count(self) -> None:
        # Compressed, variable bitrate — byte count alone never yields a
        # duration. Must return None, never a fabricated number.
        assert compute_audio_seconds(AudioFormat.MP3, 48_000, 24_000) is None

    def test_negative_sample_rate_is_none(self) -> None:
        assert compute_audio_seconds(AudioFormat.PCM, 48_000, 0) is None
