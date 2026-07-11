"""Test doubles for the TTS provider layer."""

from __future__ import annotations

from collections.abc import AsyncIterator

from tts_v2.providers.base import AudioChunk, SynthesisRequest


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
        fail_before_emit: bool = False,
        fail_after_chunks: int | None = None,
        payload: bytes = b"AUDIO",
    ) -> None:
        self.name = name
        self.supported_locales = locales or {"en-IN", "ml-IN"}
        self.native_streaming = native_streaming
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
