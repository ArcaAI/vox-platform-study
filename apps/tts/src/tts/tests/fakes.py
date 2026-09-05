"""Test doubles for the TTS provider layer."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

from tts.providers.base import AudioChunk, SynthesisRequest

if TYPE_CHECKING:  # pragma: no cover - typing only
    from tts.spec import ResolvedTtsCandidate, ResolvedTtsSpec, TtsVoiceBinding


class FakeEngine:
    """A configurable in-memory TTSEngine for tests.

    Records ``calls`` (times synthesis was iterated), ``closed`` (generator
    close/exhaust count — for cancellation assertions), and the ``requests``
    it received.
    """

    def __init__(
        self,
        name: str = "fake",
        *,
        locales: set[str] | None = None,
        native_streaming: bool = True,
        chunks: int = 2,
        healthy: bool = True,
        configured: bool = True,
        fail_before_emit: bool = False,
        fail_after_chunks: int | None = None,
        payload: bytes = b"AUDIO",
    ) -> None:
        self.name = name
        self.supported_locales = locales or {"en-IN", "ml-IN"}
        self.native_streaming = native_streaming
        self.is_configured = configured
        self._chunks = chunks
        self._healthy = healthy
        self._fail_before_emit = fail_before_emit
        self._fail_after = fail_after_chunks
        self._payload = payload
        self.calls = 0
        self.closed = 0
        self.requests: list[SynthesisRequest] = []

    async def health(self) -> bool:
        return self._healthy

    async def synthesize(self, req: SynthesisRequest) -> AsyncIterator[AudioChunk]:
        self.calls += 1
        self.requests.append(req)
        try:
            if self._fail_before_emit:
                raise RuntimeError(f"{self.name}: failed before first byte")
            for i in range(self._chunks):
                if self._fail_after is not None and i >= self._fail_after:
                    raise RuntimeError(f"{self.name}: mid-stream failure")
                yield AudioChunk(data=self._payload, is_final=(i == self._chunks - 1))
        finally:
            self.closed += 1


class FakeStream:
    """A minimal SynthesisStream test double: one audio frame per pushed fragment."""

    def __init__(self, payload: bytes = b"NATIVE") -> None:
        self._payload = payload
        self._frames: list[AudioChunk] = []
        self._ended = False
        self.pushed: list[str] = []
        self.closed = False

    async def push_text(self, text: str) -> None:
        self.pushed.append(text)
        self._frames.append(AudioChunk(data=self._payload))

    async def flush(self) -> None:
        pass

    async def end_input(self) -> None:
        self._ended = True

    def __aiter__(self) -> AsyncIterator[AudioChunk]:
        return self

    async def __anext__(self) -> AudioChunk:
        if self._frames:
            return self._frames.pop(0)
        if self._ended:
            raise StopAsyncIteration
        raise StopAsyncIteration

    async def aclose(self) -> None:
        self.closed = True


class FakeDuplexEngine(FakeEngine):
    """A FakeEngine that also advertises a native duplex ``open_stream``."""

    def __init__(self, name: str = "azure", **kw) -> None:
        super().__init__(name, **kw)
        self.streams: list[FakeStream] = []

    def open_stream(self, req: SynthesisRequest) -> FakeStream:
        stream = FakeStream()
        self.streams.append(stream)
        return stream


# ──────────────────────────────────────────────────────────────────────────────
# Resolved-spec builders (TASK-879)
#
# Every synthesis path now takes a gateway-resolved `ResolvedTtsSpec`, so a test that used to
# pass `routing_en=[...]` builds one of these instead. They are DELIBERATELY thin: the contract
# fixture (`tests/contracts/resolved-tts-spec.fixture.json`) is what pins the real shape, and a
# second full-fidelity builder here would be a place for the two to drift apart.
# ──────────────────────────────────────────────────────────────────────────────

SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000000"


def voice_binding(
    voice_id: str = "af_heart",
    *,
    locale: str | None = "en-US",
    provider_voice: str | None = None,
    ref_audio_path: str | None = None,
    ref_text: str | None = None,
) -> "TtsVoiceBinding":
    from tts.spec import TtsVoiceBinding

    return TtsVoiceBinding(
        id=voice_id,
        locale=locale,
        providerVoice=provider_voice,
        refAudioPath=ref_audio_path,
        refText=ref_text,
    )


def candidate(
    engine: str = "kokoro",
    *,
    kind: str = "primary",
    voices: "list[TtsVoiceBinding] | None" = None,
    voice: str | None = "af_heart",
    slug: str | None = None,
    source_uri: str = "hexgrad/Kokoro-82M",
    local_path: str | None = None,
    artifacts: dict[str, str] | None = None,
    connection: bool = True,
    base_url: str | None = None,
    region: str | None = None,
    timeout_s: int | None = None,
    funding: str = "platform",
    sample_rate: int | None = 24000,
    language: str | None = "en",
    agent_slug: str = "platform-tts",
    version_id: str | None = None,
) -> "ResolvedTtsCandidate":
    """One resolved candidate, with everything the router reads."""
    from tts.spec import ResolvedTtsCandidate

    bindings = voices if voices is not None else [voice_binding(voice or "af_heart")]
    key = version_id or f"agent-{agent_slug}"
    return ResolvedTtsCandidate(
        kind=kind,
        runtimeKey=key if kind != "fallback-model" else f"{key}:fallback:{slug or engine}",
        agent={
            "slug": agent_slug,
            "versionId": key,
            "versionNumber": 1,
            "tenantId": SYSTEM_TENANT_ID,
            "source": "platform-default",
        },
        model={
            "role": "primary" if kind == "primary" else "fallback",
            "slug": slug or engine,
            "taskType": "TEXT_TO_SPEECH",
            "format": "PYTORCH",
            "sourceUri": source_uri,
            "sourceRevision": None,
            "localPath": local_path,
            "checksum": None,
            "computeType": None,
            "provider": engine,
            "tenantId": SYSTEM_TENANT_ID,
            "artifacts": artifacts or {},
            "voices": [b.model_dump(by_alias=True) for b in bindings],
        },
        parameters={
            "voice": voice,
            "language": language,
            "speed": None,
            "format": None,
            "sampleRate": sample_rate,
            "ssml": False,
        },
        voice=next((b.model_dump(by_alias=True) for b in bindings if b.id == voice), None),
        connection=(
            {
                "provider": engine,
                "baseUrl": base_url,
                "region": region,
                "timeoutS": timeout_s,
                "funding": funding,
            }
            if connection
            else None
        ),
        fundingTier=funding,
    )


def spec(
    primary: "ResolvedTtsCandidate | None" = None,
    *,
    chain: "list[ResolvedTtsCandidate] | None" = None,
    auto_switch: bool = True,
) -> "ResolvedTtsSpec":
    """A whole resolved spec around one primary and an optional chain."""
    from tts.spec import RESOLVED_TTS_SPEC_SCHEMA_VERSION, ResolvedTtsSpec

    head = primary if primary is not None else candidate()
    return ResolvedTtsSpec(
        schemaVersion=RESOLVED_TTS_SPEC_SCHEMA_VERSION,
        agent=head.agent,
        primary=head,
        fallback={"autoSwitch": auto_switch, "chain": chain or []},
    )
