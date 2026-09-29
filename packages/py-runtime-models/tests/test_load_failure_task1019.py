"""TASK-1019 lane Y — a model load that fails is VISIBLE state (`failed`), not silence.

Before this, a failed factory call dropped the key and the model simply vanished
from the residency report: an operator saw "not loaded" and could not tell a model
nobody asked for from one whose weights are missing. Now the cache remembers the
last failure per key (D-8) and reports it as state `failed` with `{code, message,
at}` until the next successful load of that key, an explicit `unload(key)`, or
`clear()`.

House constraints as in `test_residency_task1005.py`: fake clocks, no GPU.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from hope_runtime_models import (
    CacheResidency,
    Device,
    DeviceMemory,
    LoadFailure,
    ModelCache,
    SyncModelCache,
)
from hope_runtime_models.residency_agent import CacheBinding, ResidencyAgent

WALL = 1_790_000_000.0


def _fixture() -> dict[str, Any]:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "tests" / "contracts" / "model-residency-agent.fixture.json"
        if candidate.exists():
            loaded: dict[str, Any] = json.loads(candidate.read_text())
            return loaded
    raise FileNotFoundError("model-residency-agent.fixture.json not found above this test")


FIXTURE = _fixture()


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


class FailureRecordingMetrics:
    def __init__(self) -> None:
        self.states: list[tuple[str, str, str, str | None]] = []
        self.failures: list[tuple[str, str, str]] = []

    def on_state(self, service: str, model: str, device: str, state: str | None) -> None:
        self.states.append((service, model, device, state))

    def on_bytes(self, service: str, model: str, device: str, measured: int | None) -> None: ...

    def on_load_seconds(self, service: str, model: str, seconds: float) -> None: ...

    def on_eviction(self, service: str, reason: str) -> None: ...

    def on_load_failure(self, service: str, model: str, code: str) -> None:
        self.failures.append((service, model, code))


def _device() -> Device:
    return Device(
        id="cuda:0",
        kind="gpu",
        memory=lambda: DeviceMemory(total_bytes=16 * 1024**3, free_bytes=12 * 1024**3),
        usage=lambda: 4 * 1024**3,
    )


class BrokenWeights(Exception):
    code = "WEIGHTS_MISSING"


class Flaky:
    """A factory the test switches between failing and working."""

    def __init__(self) -> None:
        self.error: BaseException | None = RuntimeError("weights missing")

    async def __call__(self, key: str) -> str:
        if self.error is not None:
            raise self.error
        return f"instance::{key}"

    def sync(self, key: str) -> str:
        if self.error is not None:
            raise self.error
        return f"instance::{key}"


def make_cache(flaky: Flaky, *, metrics: FailureRecordingMetrics | None = None) -> ModelCache[str]:
    return ModelCache(
        factory=flaky,
        ttl_seconds=600,
        max_size=4,
        time_func=FakeClock(),
        wall_clock=lambda: WALL,
        residency=CacheResidency(service="stt", device=_device(), metrics=metrics),
        name="asr",
    )


def make_agent(cache: Any) -> ResidencyAgent:
    return ResidencyAgent(
        service="stt",
        instance="hope-stt-test",
        bindings=lambda: [CacheBinding(cache=cache)],
        wall_clock=lambda: WALL + 30,
    )


def only_model(agent: ResidencyAgent) -> dict[str, Any]:
    (model,) = agent.report()["models"]
    return model


# ── Y1 — the failure is reported, and cleared by the three sanctioned events ─


async def test_a_loader_that_raises_is_reported_failed_with_its_error() -> None:
    flaky = Flaky()
    cache = make_cache(flaky)

    with pytest.raises(RuntimeError):
        await cache.get("whisper")

    model = only_model(make_agent(cache))
    assert model["state"] == "failed"
    assert model["model_ref"] == "whisper"
    assert model["error"] == {
        "code": "RuntimeError",
        "message": "weights missing",
        "at": "2026-09-21T14:13:20Z",
    }
    assert model["bytes"] is None and model["loaded_at"] is None
    assert cache.cached_keys() == []


async def test_a_failed_entry_carries_exactly_the_fixture_key_set() -> None:
    cache = make_cache(Flaky())
    with pytest.raises(RuntimeError):
        await cache.get("whisper")

    model = only_model(make_agent(cache))
    assert set(model) == set(FIXTURE["python"]["report"]["models"][0])
    assert model["state"] in FIXTURE["enums"]["state"]


async def test_the_error_code_is_the_exceptions_own_code_when_it_has_one() -> None:
    flaky = Flaky()
    flaky.error = BrokenWeights("no gguf in /models/whisper")
    cache = make_cache(flaky)

    with pytest.raises(BrokenWeights):
        await cache.get("whisper")

    assert only_model(make_agent(cache))["error"]["code"] == "WEIGHTS_MISSING"


async def test_the_message_is_truncated_to_500_characters() -> None:
    flaky = Flaky()
    flaky.error = RuntimeError("x" * 900)
    cache = make_cache(flaky)

    with pytest.raises(RuntimeError):
        await cache.get("whisper")

    (failure,) = cache.residency_snapshot()
    assert isinstance(failure.error, LoadFailure)
    assert len(failure.error.message) == 500


async def test_a_cancelled_load_is_not_a_failure() -> None:
    flaky = Flaky()
    flaky.error = asyncio.CancelledError()
    cache = make_cache(flaky)

    with pytest.raises(asyncio.CancelledError):
        await cache.get("whisper")

    assert cache.residency_snapshot() == []


async def test_a_later_successful_load_clears_the_failure() -> None:
    flaky = Flaky()
    cache = make_cache(flaky)
    agent = make_agent(cache)
    with pytest.raises(RuntimeError):
        await cache.get("whisper")
    assert only_model(agent)["state"] == "failed"

    flaky.error = None
    await cache.get("whisper")

    model = only_model(agent)
    assert model["state"] == "loaded"
    assert model["error"] is None


async def test_a_failed_retry_replaces_the_failure_it_does_not_stack() -> None:
    flaky = Flaky()
    cache = make_cache(flaky)
    with pytest.raises(RuntimeError):
        await cache.get("whisper")
    flaky.error = ValueError("still broken")
    with pytest.raises(ValueError):
        await cache.get("whisper")

    model = only_model(make_agent(cache))
    assert model["error"]["code"] == "ValueError"


async def test_a_retry_in_progress_reports_loading_not_failed() -> None:
    flaky = Flaky()
    cache = make_cache(flaky)
    with pytest.raises(RuntimeError):
        await cache.get("whisper")
    gate = asyncio.Event()
    started = asyncio.Event()

    async def slow(key: str) -> str:
        started.set()
        await gate.wait()
        return f"instance::{key}"

    cache._factory = slow  # noqa: SLF001 — swap the factory under a live cache
    task = asyncio.create_task(cache.get("whisper"))
    await started.wait()

    (model,) = cache.residency_snapshot()
    assert model.state == "loading" and model.error is None

    gate.set()
    await task


async def test_unload_clears_a_failure_even_though_nothing_was_resident() -> None:
    flaky = Flaky()
    cache = make_cache(flaky)
    with pytest.raises(RuntimeError):
        await cache.get("whisper")

    assert await cache.unload("whisper") is False  # nothing was resident to unload
    assert cache.residency_snapshot() == []


async def test_clear_forgets_every_failure() -> None:
    flaky = Flaky()
    cache = make_cache(flaky)
    for key in ("a", "b"):
        with pytest.raises(RuntimeError):
            await cache.get(key)
    assert len(cache.residency_snapshot()) == 2

    await cache.clear()

    assert cache.residency_snapshot() == []


async def test_the_agent_unload_of_a_failed_only_model_clears_it_and_says_not_loaded() -> None:
    """Documented choice: outcome stays `not_loaded` (nothing was loaded); the failure is dropped."""
    flaky = Flaky()
    cache = make_cache(flaky)
    agent = make_agent(cache)
    with pytest.raises(RuntimeError):
        await cache.get("whisper")

    result = await agent.unload("whisper", force=False, reason="admin")

    assert result == {"outcome": "not_loaded", "model_ref": "whisper"}
    assert agent.report()["models"] == []


async def test_a_loaded_model_reports_an_explicit_null_error() -> None:
    flaky = Flaky()
    flaky.error = None
    cache = make_cache(flaky)
    await cache.get("whisper")

    model = only_model(make_agent(cache))
    assert model["state"] == "loaded"
    assert "error" in model and model["error"] is None


def test_the_sync_cache_reports_and_clears_failures_too() -> None:
    flaky = Flaky()
    cache: SyncModelCache[str] = SyncModelCache(
        factory=flaky.sync,
        ttl_seconds=600,
        max_size=2,
        time_func=FakeClock(),
        wall_clock=lambda: WALL,
        residency=CacheResidency(service="harness", device=_device()),
        name="entailer",
    )

    with pytest.raises(RuntimeError):
        cache.get("minicheck")
    (failure,) = cache.residency_snapshot()
    assert failure.state == "failed"
    assert failure.error == LoadFailure(code="RuntimeError", message="weights missing", at=WALL)

    flaky.error = None
    cache.get("minicheck")
    (loaded,) = cache.residency_snapshot()
    assert loaded.state == "loaded" and loaded.error is None

    flaky.error = RuntimeError("again")
    cache.unload("minicheck")
    with pytest.raises(RuntimeError):
        cache.get("other")
    cache.unload("other")
    assert [m.key for m in cache.residency_snapshot()] == []


# ── Y2 — metrics ────────────────────────────────────────────────────────────


async def test_a_failed_load_counts_once_and_reports_state_failed() -> None:
    metrics = FailureRecordingMetrics()
    flaky = Flaky()
    cache = make_cache(flaky, metrics=metrics)

    with pytest.raises(RuntimeError):
        await cache.get("whisper")

    assert metrics.failures == [("stt", "whisper", "RuntimeError")]
    assert metrics.states[-1] == ("stt", "whisper", "cuda:0", "failed")

    flaky.error = None
    await cache.get("whisper")
    assert metrics.failures == [("stt", "whisper", "RuntimeError")]  # a success adds none
    assert metrics.states[-1] == ("stt", "whisper", "cuda:0", "loaded")


async def test_unloading_a_failed_key_zeroes_the_gauge() -> None:
    metrics = FailureRecordingMetrics()
    cache = make_cache(Flaky(), metrics=metrics)
    with pytest.raises(RuntimeError):
        await cache.get("whisper")

    await cache.unload("whisper")

    assert metrics.states[-1] == ("stt", "whisper", "cuda:0", None)


async def test_a_cancelled_load_counts_no_failure() -> None:
    metrics = FailureRecordingMetrics()
    flaky = Flaky()
    flaky.error = asyncio.CancelledError()
    cache = make_cache(flaky, metrics=metrics)

    with pytest.raises(asyncio.CancelledError):
        await cache.get("whisper")

    assert metrics.failures == []
    assert metrics.states[-1] == ("stt", "whisper", "cuda:0", None)


async def test_a_sink_without_the_failure_hook_still_works() -> None:
    """Sinks written before TASK-1019 have no `on_load_failure`; a load failure must not crash them."""

    class Old:
        def on_state(self, *args: Any) -> None: ...
        def on_bytes(self, *args: Any) -> None: ...
        def on_load_seconds(self, *args: Any) -> None: ...
        def on_eviction(self, *args: Any) -> None: ...

    cache = ModelCache(
        factory=Flaky(),
        ttl_seconds=600,
        max_size=2,
        residency=CacheResidency(service="stt", device=_device(), metrics=Old()),  # type: ignore[arg-type]
    )
    with pytest.raises(RuntimeError):
        await cache.get("whisper")


def test_prometheus_sink_exposes_the_failure_counter_and_the_failed_state() -> None:
    import prometheus_client

    from hope_runtime_models import LOAD_FAILURES_TOTAL, PrometheusResidencyMetrics

    registry = prometheus_client.CollectorRegistry()
    sink = PrometheusResidencyMetrics.create(prometheus_client, registry=registry)
    sink.on_state("stt", "m", "cuda:0", "loaded")
    sink.on_state("stt", "m", "cuda:0", "failed")
    sink.on_load_failure("stt", "m", "RuntimeError")
    sink.on_load_failure("stt", "m", "RuntimeError")

    assert LOAD_FAILURES_TOTAL == "model_load_failures_total"
    value = registry.get_sample_value
    labels = {"service": "stt", "model": "m", "device": "cuda:0"}
    assert value("model_resident", {**labels, "state": "failed"}) == 1
    assert value("model_resident", {**labels, "state": "loaded"}) == 0
    assert (
        value("model_load_failures_total", {"service": "stt", "model": "m", "code": "RuntimeError"})
        == 2
    )
