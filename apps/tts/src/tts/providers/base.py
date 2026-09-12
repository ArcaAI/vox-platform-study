"""Provider abstraction for TTS engines.

A ``TTSEngine`` turns text into a stream of audio chunks. Engines are held in a
``ProviderRegistry`` and selected by the router per request. This mirrors the
TEXT provider pattern (Protocol + registry) adapted for audio synthesis.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, runtime_checkable


class CredentialPosture(StrEnum):
    """How a TTS adapter obtains the credential it authenticates with.

    This exists so the BYOK lock test can iterate the REGISTRY instead of a
    hand-written list of provider names — and so the ROUTER can build a
    per-tenant override engine by asking the adapter rather than by matching
    its name against a literal.

    That distinction is not cosmetic. ``router._build_spec_engine``'s ancestor
    was an ``if name == "azure" / "sarvam"`` switch: a BYOK adapter the switch
    did not name returned ``None``, silently fell back to the shared registered
    engine, and served every tenant on the PLATFORM key. It is the same shape of
    defect that let ``bedrock`` and ``vertex`` keep ambient credential chains in
    ``apps/text`` for years — a list can only cover the adapters someone
    remembered.

    An adapter that declares NOTHING fails the lock test. Default-deny is the
    point: a new provider is not silently assumed credential-free.
    """

    #: Vendor credential REQUIRED. It arrives per request as a gateway-injected
    #: provider override (tenant → SYSTEM ``AiProviderConnection``). Absent it,
    #: the adapter MUST report ``is_configured == False`` so the router excludes
    #: it from candidates, rather than construct a client that would
    #: authenticate from the process environment.
    BYOK = "byok"
    #: An operator-run engine whose weights are local (Kokoro, Indic Parler,
    #: Indic F5). No vendor credential is required, so there is nothing to fail
    #: closed on.
    SELF_HOST = "self_host"


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
    # Stamped by the ROUTER only (never a provider adapter) with the name of
    # the provider that actually produced this chunk. A request doesn't know
    # which candidate in the failover chain won until the first byte ships, so
    # this is how a caller (the usage-metering endpoints)
    # learns it without re-deriving router-internal failover state.
    provider: str | None = None
    # TASK-958 — WHICH connection of that provider produced it. Stamped by the ROUTER
    # beside `provider`, for the same reason and at the same moment: since a tenant may
    # hold several connections for one vendor, two candidates in a chain can share an
    # engine NAME and differ only by the account they authenticate to, so `provider`
    # alone can no longer tell the usage ledger which key was spent.
    connection_id: str | None = None
    # TASK-959 — the serving engine's CONFIGURED device (`cuda`/`mps`/`cpu`), stamped by
    # the ROUTER from the provider's own settings sub-config (e.g. `KokoroConfig.device`).
    # `None` for a cloud engine (Azure, Sarvam) that names no device of ours — never a guess.
    device: str | None = None
    # TASK-959 — time-to-first-audio in milliseconds, stamped by the ROUTER only on the FIRST
    # chunk of the winning candidate (`None` on every later chunk). It is the one synthesis
    # timing fact known before the last byte ships, so it is what a caller draining the stream
    # incrementally (raw/SSE) can report; a caller that buffers the whole utterance (batch) has
    # the router's own total instead (see `TTSRouter.synthesize`'s `timing` parameter).
    ttfa_ms: float | None = None


class ProviderNotFoundError(KeyError):
    """Raised when a provider name is not registered."""


@runtime_checkable
class TTSEngine(Protocol):
    """Contract every synthesis engine implements.

    ``native_streaming`` tells the router whether the engine emits audio
    incrementally as it synthesizes (True) or as a full utterance (False). For
    non-streaming engines the router applies a sentence adapter so first audio
    still ships after the first sentence.

    Every implementation must also carry a ``credential_posture`` class attribute
    (see ``CredentialPosture``) and a ``from_spec`` classmethod — the ONE factory
    the router uses to build a request-scoped engine from a resolved TTS spec
    candidate (TASK-879). It replaced ``from_override``: a candidate carries the
    model, mirror, artifacts, endpoint and region as well as the credential, so
    two factories would have meant two places to get a tenant's engine wrong.
    Neither obligation is declared as a member of this Protocol:
    ``runtime_checkable`` turns any non-method member into an ``isinstance``
    requirement, which would change ``isinstance(x, TTSEngine)`` for every
    duck-typed test double in the codebase. The obligation is enforced instead by
    the registry-iterating lock test
    (``tests/unit/test_task799_byok_credentials.py``), which fails for any
    adapter that does not declare one.
    """

    name: str
    supported_locales: set[str]
    native_streaming: bool
    # True when the engine has a usable credential/configuration. A cloud
    # BYOK engine registered from empty platform config is `False` and the router
    # excludes it from candidates (it can still serve via a per-request override
    # engine); self-hosted engines are always `True`.
    is_configured: bool

    async def health(self) -> bool: ...

    def synthesize(self, req: SynthesisRequest) -> AsyncGenerator[AudioChunk, None]: ...


@runtime_checkable
class SynthesisStream(Protocol):
    """A duplex synthesis stream: push incremental text in, iterate audio out.

    Used by the WS-duplex path for speak-while-generating: TEXT tokens
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
    """Name → engine registry (mirrors text.providers.base.ProviderRegistry)."""

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
