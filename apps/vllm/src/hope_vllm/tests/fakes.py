"""Test doubles for the engine seam (``hope_vllm.engine.base``)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from hope_vllm.engine.base import DecodeRequest, DecodeResult
from hope_vllm.spec import ResolvedVllmAsrSpec


@dataclass
class FakeEngine:
    """Records every decode; optional delay lets tests hold requests in flight."""

    spec: ResolvedVllmAsrSpec
    text: str = "hello world from the fake engine"
    finish_reason: str | None = "stop"
    delay_s: float = 0.0
    requests: list[DecodeRequest] = field(default_factory=list)
    inflight: int = 0
    max_inflight: int = 0
    shut_down: bool = False

    async def transcribe(self, request: DecodeRequest) -> DecodeResult:
        self.requests.append(request)
        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        try:
            if self.delay_s:
                await asyncio.sleep(self.delay_s)
            return DecodeResult(
                text=self.text,
                finish_reason=self.finish_reason,
                decode_ms=1.0,
                engine_queue_ms=None,
            )
        finally:
            self.inflight -= 1

    async def shutdown(self) -> None:
        self.shut_down = True


@dataclass
class FakeEngineFactory:
    """Builds FakeEngines; can be made unavailable, slow, or failing."""

    name: str = "fake"
    unavailable_reason: str | None = None
    build_delay_s: float = 0.0
    fail_with: Exception | None = None
    engine_delay_s: float = 0.0
    engine_text: str = "hello world from the fake engine"
    engine_finish_reason: str | None = "stop"
    builds: list[str] = field(default_factory=list)
    engines: dict[str, FakeEngine] = field(default_factory=dict)

    def availability(self) -> str | None:
        return self.unavailable_reason

    async def build(self, spec: ResolvedVllmAsrSpec) -> FakeEngine:
        self.builds.append(spec.runtime_key)
        if self.build_delay_s:
            await asyncio.sleep(self.build_delay_s)
        if self.fail_with is not None:
            raise self.fail_with
        engine = FakeEngine(
            spec=spec,
            text=self.engine_text,
            finish_reason=self.engine_finish_reason,
            delay_s=self.engine_delay_s,
        )
        self.engines[spec.runtime_key] = engine
        return engine
