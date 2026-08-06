"""Usage-metering primitives for TASK-615 WS-E (TTS characters + audio-seconds).

Two pure, side-effect-free functions the endpoints (``api/endpoints/speech.py``,
``api/endpoints/stream_ws.py``) and the router's RTF metric share, so the byte
math backing a billed quantity and the byte math backing an internal SLO metric
never drift apart.
"""

from __future__ import annotations

from tts.core.metrics import TTS_CHARACTERS_TOTAL, TTS_SYNTHESIZED_SECONDS_TOTAL
from tts.providers.base import AudioFormat

# Raw s16le mono PCM: 2 bytes per sample.
_PCM_BYTES_PER_SAMPLE = 2
# Standard canonical RIFF/WAVE header size for the PCM streams this service
# writes (44 bytes: RIFF+WAVE+fmt chunk+data chunk headers, no extra chunks).
_WAV_HEADER_BYTES = 44

# Provider label when synthesis produced zero chunks (failure before the
# first byte) — keeps the Prometheus label set finite rather than emitting an
# unlabeled series.
UNKNOWN_PROVIDER = "none"


def count_characters(text: str) -> int:
    """Accepted-input character count — 1 Unicode CODE POINT = 1 character.

    Frozen contract (``ws-b-contract.md`` §3 / TASK-615 README §3): no CJK/Indic
    double-counting. Python 3 ``str`` already stores actual code points (PEP
    393, not UTF-16 code units), so ``len(text)`` IS the code-point count —
    including astral-plane characters (most emoji) as a single unit.
    """
    return len(text)


def compute_audio_seconds(fmt: AudioFormat, audio_bytes: int, sample_rate: int) -> float | None:
    """Derive synthesized audio duration from a byte count (the RTF byte math
    ``routing/router.py`` already uses for the ``tts_rtf`` metric, shared here
    so the billed quantity and the SLO metric are computed identically).

    - PCM: raw s16le mono -> ``bytes / (2 * sample_rate)``.
    - WAV: the same PCM payload behind a fixed 44-byte header -> subtract the
      header first.
    - MP3 (and any other/unknown format): compressed, variable-bitrate — a
      byte count alone never yields a duration. Returns ``None`` rather than a
      fabricated number; the caller (Prometheus label / usage row) must treat
      an absent value as "not derivable", never as zero.

    Returns ``None`` for a non-positive sample rate or a payload that resolves
    to zero or negative audio.
    """
    if sample_rate <= 0 or audio_bytes <= 0:
        return None

    if fmt == AudioFormat.PCM:
        payload_bytes = audio_bytes
    elif fmt == AudioFormat.WAV:
        payload_bytes = audio_bytes - _WAV_HEADER_BYTES
    else:
        return None

    if payload_bytes <= 0:
        return None
    return payload_bytes / (_PCM_BYTES_PER_SAMPLE * sample_rate)


def record_usage_metrics(
    *, provider: str | None, locale: str, characters: int, audio_seconds: float | None, status: str
) -> None:
    """Shared Prometheus recorder for both TTS entry points (HTTP
    ``/audio/speech`` and the WS-duplex ``/audio/stream``) — TASK-615 WS-E.

    The gateway (not this counter) is the usage-LEDGER's source of truth
    (D3); this is the platform-metrics/Grafana signal.
    """
    labels = {"provider": provider or UNKNOWN_PROVIDER, "locale": locale, "status": status}
    TTS_CHARACTERS_TOTAL.labels(**labels).inc(characters)
    if audio_seconds is not None:
        TTS_SYNTHESIZED_SECONDS_TOTAL.labels(**labels).inc(audio_seconds)
