"""Duplex (native-streaming) ASR engine contract — TASK-998.

The engine surface this module defines exists alongside, not instead of,
``StreamingAsrCallable`` (``session_manager.py:145``).

``StreamingAsrCallable`` is request/response: HOPE segments the audio with its
own VAD and hands the engine one bounded utterance buffer per call. That shape
is correct for a LOCAL decoder we drive ourselves, and it is what every local
engine keeps using. It is wrong for a cloud vendor that runs its own
endpointer: the vendor's segmentation and ours disagree, every call pays a
connection, the vendor's interim hypotheses are unreachable, and any per-call
duration ceiling the vendor imposes becomes a hard failure on a long utterance.

A DUPLEX engine owns the conversation instead. HOPE pushes a continuous frame
feed and consumes an event stream; the VENDOR decides where utterances end.
Consequences that callers must respect:

* **Local VAD is bypassed for duplex engines** (owner decision OD-2,
  2026-09-21). Resample / normalise / denoise still run — they are signal
  conditioning, not segmentation — but no HOPE endpointer, semantic or
  otherwise, may cut a duplex stream. Two endpointers in series is the defect
  this contract exists to remove.
* **Partials come from the vendor, not from re-decoding.** HOPE must not fire
  its own partial inference against a duplex engine; ``is_final=False`` events
  arrive on the stream.
* **Errors keep the existing taxonomy.** A duplex session raises / emits the
  same ``CloudASRAuthError`` / ``CloudASRQuotaError`` /
  ``CloudASRTranscriptionError`` (``stt.core.exceptions``) so
  ``EngineSwitchController`` classification is unchanged.

An engine opts in by overriding ``AsrEngine.make_streaming_session`` to return a
``DuplexAsrSession``; returning ``None`` (the default) keeps the per-utterance
callable path. Nothing about the local engines changes.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

import numpy as np

__all__ = [
    "DuplexAsrSession",
    "DuplexEndpointing",
    "DuplexError",
    "DuplexEvent",
    "DuplexSessionClosed",
    "DuplexSpeechActivity",
    "DuplexTranscript",
]


@dataclass(frozen=True)
class DuplexTranscript:
    """One transcript event from the vendor.

    ``is_final`` carries the vendor's own finality, NOT a HOPE VAD boundary —
    it maps straight onto ``SegmentResult.is_final`` (``schemas.py:180``).

    ``start_time`` / ``end_time`` are seconds from session start when the
    vendor supplies them (Sarvam ``start_s``/``end_s`` on finals; Azure
    offset/duration). ``None`` means the vendor did not say, and the consumer
    must fall back to its own wall-clock span — it must NOT invent zeros,
    which would collide with real timings at the start of a session.
    """

    text: str
    is_final: bool
    language: str | None = None
    language_confidence: float | None = None
    start_time: float | None = None
    end_time: float | None = None
    word_timestamps: list[dict[str, Any]] = field(default_factory=list)
    #  TASK-959 metering; a duplex session reports bytes on the SESSION, so a
    #  per-event count is optional and may be ``None`` rather than a false 0.
    request_bytes: int | None = None
    response_bytes: int | None = None


@dataclass(frozen=True)
class DuplexSpeechActivity:
    """Vendor-side VAD transition (Sarvam ``vad.speech_start``/``speech_end``,
    OpenAI ``input_audio_buffer.speech_started``/``stopped``). Advisory only —
    useful for UI affordances and telemetry; it must not drive segmentation,
    which the vendor already did."""

    started: bool
    at_time: float | None = None


@dataclass(frozen=True)
class DuplexError:
    """A non-fatal vendor error. Fatal conditions raise the ``CloudASR*``
    exceptions instead, so the engine-switch path is untouched."""

    code: str
    message: str
    is_fatal: bool = False


@dataclass(frozen=True)
class DuplexSessionClosed:
    """Terminal event. ``audio_duration_s`` is the vendor's own accounting
    where it reports one (Sarvam ``session.end``), for metering reconciliation."""

    reason: str
    audio_duration_s: float | None = None


DuplexEvent = DuplexTranscript | DuplexSpeechActivity | DuplexError | DuplexSessionClosed


@dataclass(frozen=True)
class DuplexEndpointing:
    """Normalised server-side endpointing request.

    Each provider maps what it supports and IGNORES the rest — a knob a vendor
    does not expose is dropped, never emulated locally, because emulating it
    would reintroduce the second endpointer this contract removes. An adapter
    that drops a knob logs it once per session so the omission is visible
    rather than silent (the ``prompt``-accepted-then-discarded defect this
    ticket also fixes).
    """

    mode: Literal["server_vad", "semantic", "manual"] = "server_vad"
    #  Vendor VAD sensitivity, 0..1 where higher is stricter. Sarvam
    #  ``threshold`` (0.3), OpenAI ``turn_detection.threshold`` (0.5).
    threshold: float | None = None
    #  Trailing silence that ends a turn. Sarvam ``silence_duration_ms`` (500),
    #  OpenAI ``turn_detection.silence_duration_ms``, Azure end-silence timeout.
    silence_duration_ms: int | None = None
    #  Shortest accepted utterance. Sarvam ``min_speech_duration_ms`` (250).
    min_speech_duration_ms: int | None = None
    #  Audio retained before the detected onset, where the vendor exposes it
    #  (OpenAI ``prefix_padding_ms``).
    prefix_padding_ms: int | None = None


@runtime_checkable
class DuplexAsrSession(Protocol):
    """A live, vendor-side streaming recognition session.

    Lifecycle is ``open() -> (push_audio* || events()) -> close()``. ``open``
    and ``close`` are idempotent. ``events()`` yields until the session ends and
    then stops; a consumer treats exhaustion as end-of-session.

    Implementations are responsible for their own keepalive (Sarvam closes an
    idle socket with 1008) and for mapping vendor auth/quota/transport failures
    onto the ``CloudASR*`` taxonomy.
    """

    async def open(self) -> None:
        """Connect and send the session configuration. Raises ``CloudASRAuthError``
        on a rejected credential."""
        ...

    async def push_audio(self, samples: np.ndarray, sample_rate: int) -> None:
        """Submit conditioned mono float32 [-1, 1] frames.

        The adapter owns wire encoding (PCM16 / base64 / whatever the vendor
        wants) and any resampling to a rate the vendor accepts. Callers push
        small, regular frames — roughly 100 ms — and never a whole utterance.
        """
        ...

    async def signal_utterance_end(self) -> None:
        """Force a turn boundary under ``mode='manual'``, and flush at
        end-of-stream. A no-op for a vendor that offers no manual flush."""
        ...

    def events(self) -> AsyncIterator[DuplexEvent]:
        """Vendor events in arrival order. Exactly one ``DuplexSessionClosed``
        is yielded last."""
        ...

    async def close(self) -> None:
        """Flush, close the transport, release resources."""
        ...

    @property
    def provider(self) -> str:
        """``"sarvam"`` | ``"openai"`` | ``"azure-speech"`` — the metering and
        error-label key, matching ``CloudRestConfig.provider``."""
        ...
