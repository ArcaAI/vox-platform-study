"""Provider abstraction for TTS engines.

A ``TTSEngine`` turns text into a stream of audio chunks. Engines are held in a
``ProviderRegistry`` and selected by the router per request. This mirrors the
SMR provider pattern (Protocol + registry) adapted for audio synthesis.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, runtime_checkable


class AudioFormat(StrEnum):
    """Output container/encoding. PCM is raw s16le mono (streaming default)."""

    PCM = "pcm"
    WAV = "wav"
    MP3 = "mp3"


CONTENT_TYPES: dict[AudioFormat, str] = {
    AudioFormat.PCM: "audio/pcm",
    AudioFormat.WAV: "audio/wav",
    AudioFormat.MP3: "audio/mpeg",
}


@dataclass
class SynthesisRequest:
    """A resolved, provider-ready synthesis request (built by the router)."""

    text: str
    provider_voice: str
    locale: str
    fmt: AudioFormat = AudioFormat.PCM
    speed: float = 1.0
    sample_rate: int = 24000
    request_id: str = ""


@dataclass
class AudioChunk:
    """A chunk of encoded audio bytes in the request's format."""

    data: bytes
    is_final: bool = False


class ProviderNotFoundError(KeyError):
    """Raised when a provider name is not registered."""


@runtime_checkable
class TTSEngine(Protocol):
    """Contract every synthesis engine implements.

    ``native_streaming`` tells the router whether the engine emits audio
    incrementally as it synthesizes (True) or as a full utterance (False). For
    non-streaming engines the router applies a sentence adapter so first audio
    still ships after the first sentence.
    """

    name: str
    supported_locales: set[str]
    native_streaming: bool

    async def health(self) -> bool: ...

    def synthesize(self, req: SynthesisRequest) -> AsyncIterator[AudioChunk]: ...


@runtime_checkable
class SynthesisStream(Protocol):
    """A duplex synthesis stream: push incremental text in, iterate audio out.

    Used by the WS-duplex path for speak-while-generating: SMR tokens
    are pushed in as they stream, and audio frames come out per sentence. A
    non-streaming engine is wrapped by ``SentenceAdapter``; a natively duplex
    engine (Azure text-stream) exposes this directly via ``open_stream``.
    """

    async def push_text(self, text: str) -> None:
        """Feed a text fragment (a trailing space marks a likely boundary)."""
        ...

    async def flush(self) -> None:
        """Force-emit any buffered text as a boundary now."""
        ...

    async def end_input(self) -> None:
        """Signal no more input; drain the remainder and finish the stream."""
        ...

    def __aiter__(self) -> AsyncIterator[AudioChunk]: ...

    async def aclose(self) -> None:
        """Cancel and free upstream resources (Azure connection / GPU task)."""
        ...


@runtime_checkable
class DuplexTTSEngine(Protocol):
    """Optional capability: an engine with a native incremental-text duplex.

    The router prefers ``open_stream`` when present (Azure text-stream); every
    other engine is driven per-sentence through ``SentenceAdapter`` over
    ``synthesize``.
    """

    def open_stream(self, req: SynthesisRequest) -> SynthesisStream: ...


class ProviderRegistry:
    """Name → engine registry (mirrors smr_v2.providers.base.ProviderRegistry)."""

    def __init__(self) -> None:
        self._providers: dict[str, TTSEngine] = {}

    def register(self, name: str, provider: TTSEngine) -> None:
        self._providers[name] = provider

    def get(self, name: str) -> TTSEngine:
        try:
            return self._providers[name]
        except KeyError as exc:
            raise ProviderNotFoundError(name) from exc

    def unregister(self, name: str) -> None:
        self._providers.pop(name, None)

    def list_providers(self) -> list[str]:
        return list(self._providers.keys())

    def __contains__(self, name: object) -> bool:
        return name in self._providers
