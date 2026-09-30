"""Test doubles for the engine seam (``hope_vllm.engine.base``)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from hope_vllm.core.serving_spec_client import (
    ModelNotFound,
    ModelNotServable,
    ServingSpecUnavailable,
)
from hope_vllm.engine.base import DecodeRequest, DecodeResult
from hope_vllm.spec import ResolvedServingSpec
from hope_vllm.tests.payloads import RUNTIME_KEY, SLUG, serving_spec_payload


@dataclass
class FakeEngine:
    """Records every decode; optional delay lets tests hold requests in flight."""

    spec: ResolvedServingSpec
    text: str = "hello world from the fake engine"
    finish_reason: str | None = "stop"
    delay_s: float = 0.0
    requests: list[DecodeRequest] = field(default_factory=list)
    engine_queue_ms: float | None = None
    inflight: int = 0
    max_inflight: int = 0
    shut_down: bool = False
    aborted: list[str] = field(default_factory=list)
    shutdown_delay_s: float = 0.0
    shutdown_calls: int = 0
    #: Shared with the factory: `(event, runtime_key)` in the order things happened.
    events: list[tuple[str, str]] = field(default_factory=list)

    async def transcribe(self, request: DecodeRequest) -> DecodeResult:
        self.requests.append(request)
        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        try:
            if self.delay_s:
                await asyncio.sleep(self.delay_s)
        except asyncio.CancelledError:
            # What `VllmWhisperEngine` does: free the batch slot for a caller who left.
            self.aborted.append(request.request_id)
            raise
        finally:
            self.inflight -= 1
        return DecodeResult(
            text=self.text,
            finish_reason=self.finish_reason,
            decode_ms=1.0,
            engine_queue_ms=self.engine_queue_ms,
        )

    async def shutdown(self) -> None:
        self.shutdown_calls += 1
        self.events.append(("shutdown_started", self.spec.runtime_key))
        if self.shutdown_delay_s:
            await asyncio.sleep(self.shutdown_delay_s)
        self.shut_down = True
        self.events.append(("shutdown_done", self.spec.runtime_key))


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
    engine_queue_ms: float | None = None
    shutdown_delay_s: float = 0.0
    builds: list[str] = field(default_factory=list)
    engines: dict[str, FakeEngine] = field(default_factory=dict)
    events: list[tuple[str, str]] = field(default_factory=list)

    def availability(self) -> str | None:
        return self.unavailable_reason

    async def build(self, spec: ResolvedServingSpec) -> FakeEngine:
        self.builds.append(spec.runtime_key)
        self.events.append(("build", spec.runtime_key))
        if self.build_delay_s:
            await asyncio.sleep(self.build_delay_s)
        if self.fail_with is not None:
            raise self.fail_with
        engine = FakeEngine(
            spec=spec,
            text=self.engine_text,
            finish_reason=self.engine_finish_reason,
            delay_s=self.engine_delay_s,
            engine_queue_ms=self.engine_queue_ms,
            shutdown_delay_s=self.shutdown_delay_s,
            events=self.events,
        )
        self.engines[spec.runtime_key] = engine
        return engine


@dataclass
class FakeSpecResolver:
    """Stands in for `ServingSpecClient`: every slug resolves unless told otherwise.

    The default slug resolves to `serving_spec_payload()` (runtime key `RUNTIME_KEY`);
    any other slug to the same row under `<slug>:v1`. `specs` overrides a slug's payload,
    `missing` makes it 404, `not_servable` a 409 with that reason, `fail` a gateway fault.
    """

    specs: dict[str, dict[str, object]] = field(default_factory=dict)
    missing: set[str] = field(default_factory=set)
    not_servable: dict[str, str] = field(default_factory=dict)
    fail: bool = False
    calls: list[tuple[str, str]] = field(default_factory=list)

    async def resolve(self, slug: str, tenant_id: str) -> ResolvedServingSpec:
        self.calls.append((slug, tenant_id))
        if self.fail:
            raise ServingSpecUnavailable("gateway down")
        if slug in self.missing:
            raise ModelNotFound(slug)
        if slug in self.not_servable:
            raise ModelNotServable(self.not_servable[slug])
        payload = self.specs.get(slug) or serving_spec_payload(
            slug=slug, runtimeKey=RUNTIME_KEY if slug == SLUG else f"{slug}:v1"
        )
        return ResolvedServingSpec.model_validate(payload)
