"""The pool across the process lifetime: named pool at start, pins, and a load that blocks.

* ``VLLM_POOL`` names an entry of ``vllm.pools``; a name the map does not declare means the
  process refuses to start (``PoolNotConfiguredError``), after the control plane had its
  chance to declare it.
* Pins are resolved against the SYSTEM tenant and loaded in the BACKGROUND of the lifespan;
  ``/health/startup`` stays 503 until every pin is resident, while ``/health/live`` keeps
  answering (a kubelet must not restart a replica for loading weights).
* Review focus 3: the first request for an UNPINNED model must not stall ``/health/live``
  — the real backend builds in ``asyncio.to_thread``.
"""

from __future__ import annotations

import asyncio
import importlib.machinery
import sys
import time
import types
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from hope_vllm.core.config import PoolNotConfiguredError, Settings
from hope_vllm.core.control_plane import apply_control_plane
from hope_vllm.core.serving_spec_client import ServingSpecUnavailable
from hope_vllm.engine.pool import SYSTEM_TENANT_ID
from hope_vllm.engine.vllm_backend import VllmEngineFactory
from hope_vllm.main import create_app
from hope_vllm.spec import ResolvedServingSpec
from hope_vllm.tests.conftest import serving_spec_payload
from hope_vllm.tests.fakes import FakeEngineFactory


class FakeSpecResolver:
    """Stands in for `ServingSpecClient`; records `(slug, tenant)` per call."""

    def __init__(self, fail: Exception | None = None) -> None:
        self.calls: list[tuple[str, str]] = []
        self.fail = fail

    async def resolve(self, slug: str, tenant_id: str) -> ResolvedServingSpec:
        self.calls.append((slug, tenant_id))
        if self.fail is not None:
            raise self.fail
        return ResolvedServingSpec.model_validate(
            serving_spec_payload(slug=slug, runtimeKey=f"{slug}:v1", vramGiB=2)
        )


def with_pins(settings: Settings, *pins: str) -> Settings:
    pool = {
        "acceptedKinds": ["asr"],
        "pins": list(pins),
        "vramBudgetGiB": 6,
        "maxResidentEngines": 2,
    }
    applied = apply_control_plane(
        settings, {"settings": {"vllm.pools": {"value": {"default": pool}}}}
    )
    assert applied == ["vllm.pools"]
    return settings


async def wait_for(predicate: Any, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.01)


async def test_a_pool_name_the_map_does_not_declare_refuses_to_start(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    monkeypatch.setenv("VLLM_POOL", "llm")
    app = create_app(Settings(), engine_factory=FakeEngineFactory())
    with pytest.raises(PoolNotConfiguredError):
        async with app.router.lifespan_context(app):
            pass  # pragma: no cover - never reached


async def test_pins_load_in_the_background_and_gate_startup(settings: Settings) -> None:
    factory = FakeEngineFactory(build_delay_s=0.2)
    resolver = FakeSpecResolver()
    app = create_app(
        with_pins(settings, "pin-a", "pin-b"),
        engine_factory=factory,
        serving_spec_client=resolver,
    )
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            assert (await client.get("/api/v1/health/startup")).status_code == 503
            live = await asyncio.wait_for(client.get("/api/v1/health/live"), timeout=0.1)
            assert live.status_code == 200

            await wait_for(lambda: len(factory.engines) == 2)
            await wait_for(lambda: getattr(app.state, "pins_task", None) is not None)
            await app.state.pins_task

            assert (await client.get("/api/v1/health/startup")).status_code == 200
    assert resolver.calls == [("pin-a", SYSTEM_TENANT_ID), ("pin-b", SYSTEM_TENANT_ID)]
    assert factory.builds == ["pin-a:v1", "pin-b:v1"]


async def test_no_pins_means_startup_is_healthy_at_once(client) -> None:  # type: ignore[no-untyped-def]
    assert (await client.get("/api/v1/health/startup")).status_code == 200


async def test_a_pin_that_cannot_be_resolved_keeps_startup_503(settings: Settings) -> None:
    resolver = FakeSpecResolver(fail=ServingSpecUnavailable("gateway down"))
    app = create_app(
        with_pins(settings, "pin-a"),
        engine_factory=FakeEngineFactory(),
        serving_spec_client=resolver,
    )
    async with app.router.lifespan_context(app):
        await app.state.pins_task
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            assert (await client.get("/api/v1/health/startup")).status_code == 503
            assert (await client.get("/api/v1/health/live")).status_code == 200


# ── review focus 3: a blocking load never stalls liveness ───────────────────


class BlockingAsyncLLM:
    """`AsyncLLM.from_engine_args` blocks its thread for 2 s, as a real weight load does."""

    def __init__(self) -> None:
        self.model_config = SimpleNamespace(max_model_len=448)

    @classmethod
    def from_engine_args(cls, engine_args: Any) -> BlockingAsyncLLM:
        time.sleep(2.0)
        return cls()

    def shutdown(self) -> None:
        pass


@pytest.fixture
def blocking_vllm(monkeypatch: pytest.MonkeyPatch) -> None:
    def module(name: str) -> types.ModuleType:
        mod = types.ModuleType(name)
        mod.__spec__ = importlib.machinery.ModuleSpec(name, None)
        monkeypatch.setitem(sys.modules, name, mod)
        return mod

    root = module("vllm")
    root.AsyncEngineArgs = lambda **kwargs: kwargs  # type: ignore[attr-defined]
    root.SamplingParams = dict  # type: ignore[attr-defined]
    inputs = module("vllm.inputs")
    inputs.ExplicitEncoderDecoderPrompt = dict  # type: ignore[attr-defined]
    inputs.TextPrompt = dict  # type: ignore[attr-defined]
    module("vllm.v1")
    module("vllm.v1.engine")
    module("vllm.v1.engine.async_llm").AsyncLLM = BlockingAsyncLLM  # type: ignore[attr-defined]


class LocalDir:
    async def resolve(self, spec: ResolvedServingSpec) -> Path:
        return Path("/weights")


async def test_liveness_answers_within_100ms_while_the_real_backend_blocks_2s(
    blocking_vllm: None, settings: Settings
) -> None:
    factory = VllmEngineFactory(
        settings,
        source_resolver=LocalDir(),
        token_counter_loader=lambda _dir: (lambda text: 4),
        cuda_capability=lambda: (8, 9),
        device_total_gib=lambda: 16.0,
    )
    app = create_app(settings, engine_factory=factory)
    spec = ResolvedServingSpec.model_validate(serving_spec_payload())
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            load = asyncio.create_task(app.state.engine_pool.warm(spec))
            await asyncio.sleep(0.1)  # the build is now inside its worker thread
            assert not load.done()
            started = time.perf_counter()
            live = await client.get("/api/v1/health/live")
            elapsed = time.perf_counter() - started
            assert live.status_code == 200
            assert elapsed < 0.1, f"/health/live took {elapsed * 1000:.0f} ms during a load"
            await load


# ── fix round 1 · I2: a control-plane refresh re-resolves pinned SLUGS ──────


async def test_a_control_plane_refresh_moves_the_pin_to_the_rows_new_runtime_key(
    settings: Settings,
) -> None:
    import httpx

    from hope_vllm.core.effective_config import EffectiveConfigClient, refresh_control_plane

    pool = {"acceptedKinds": ["asr"], "pins": ["pin"], "vramBudgetGiB": 3, "maxResidentEngines": 1}

    async def gateway(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"settings": {"vllm.pools": {"value": {"default": pool}}}})

    now = {"t": 1000.0}
    client = EffectiveConfigClient(
        base_url="http://gw.test/api/v1",
        token="t",
        transport=httpx.MockTransport(gateway),
        time_func=lambda: now["t"],
    )
    from hope_vllm.tests.fakes import FakeSpecResolver as SharedResolver

    resolver = SharedResolver()
    resolver.specs["pin"] = serving_spec_payload(slug="pin", runtimeKey="pin:v1", vramGiB=3)
    factory = FakeEngineFactory()
    app = create_app(
        settings,
        engine_factory=factory,
        serving_spec_client=resolver,
        effective_config_client=client,
    )
    async with app.router.lifespan_context(app):
        await app.state.pins_task
        assert factory.builds == ["pin:v1"]

        resolver.specs["pin"] = serving_spec_payload(slug="pin", runtimeKey="pin:v2", vramGiB=3)
        now["t"] += 120  # the snapshot is stale: the next refresh really fetches
        await refresh_control_plane(app.state)
        await app.state.pins_refresh

        snapshot = app.state.engine_pool.snapshot()
        assert [(e["runtime_key"], e["pinned"]) for e in snapshot["loaded"]] == [("pin:v2", True)]
        assert factory.engines["pin:v1"].shut_down is True
