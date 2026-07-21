"""Harness takes entailer retention from the control plane.

The `configure_entailer_cache` seam needs a caller so that
`harness.modelCache.ttlSeconds` reaches the MiniCheck GGUF.

The placement constraint is the interesting part: the entailer is built
inside a Temporal ACTIVITY, so its weights are resident in the WORKER process,
not the FastAPI app. A refresh installed in the app's lifespan would reconfigure
a cache that holds nothing. These tests pin the refresh to the worker's periodic
path — the same place the model-cache sweep runs.

Hermetic: `httpx.MockTransport`, a fake clock, and a stub entailer factory. No
Temporal server, no llama.cpp, no network. `test_replay_compat.py` is untouched.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

ENV_TTL_S = 600


def _payload(ttl_seconds: int | None = None, max_models: int | None = None) -> dict[str, Any]:
    return {
        "service": "harness",
        "generatedAt": "2026-07-20T00:00:00.000Z",
        "retention": {
            "ttlSeconds": ttl_seconds,
            "maxModels": max_models,
            "maxMemoryMb": None,
            "vramBudgetMb": None,
            "source": "db",
        },
    }


def _client(handler):  # noqa: ANN001,ANN202
    from harness.core.effective_config import EffectiveConfigClient

    return EffectiveConfigClient(
        base_url="http://gateway.test/api/v1",
        token="harness-token",
        service="harness",
        transport=httpx.MockTransport(handler),
    )


@pytest.fixture(autouse=True)
def _fresh_entailer_cache():  # noqa: ANN202
    """Each test gets a pristine module-level cache singleton."""
    from harness.sensors.inferential import minicheck_entailer

    minicheck_entailer.reset_entailer_cache()
    yield
    minicheck_entailer.reset_entailer_cache()


def _env_baseline() -> None:
    from harness.core.config import get_settings

    assert get_settings().model_cache_ttl_seconds == ENV_TTL_S, "env baseline moved"


# ── clause 1 — the control plane wins over env ──────────────────────────────


@pytest.mark.asyncio
async def test_retention_comes_from_control_plane() -> None:
    from harness.sensors.inferential import minicheck_entailer
    from harness.temporal.worker import _refresh_model_cache_retention_once

    _env_baseline()

    await _refresh_model_cache_retention_once(
        _client(lambda _r: httpx.Response(200, json=_payload(ttl_seconds=900, max_models=2)))
    )

    stats = minicheck_entailer.entailer_cache_stats()
    assert stats.ttl_seconds == 900
    assert stats.max_size == 2


# ── clause 2 — LIVE cache reconfigured, resident entailer kept ───────────────


@pytest.mark.asyncio
async def test_live_cache_reconfigured_not_just_new_ones(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """§3.2 — a resident GGUF must follow a later control-plane change."""
    from harness.sensors.inferential import minicheck_entailer
    from harness.temporal.worker import _refresh_model_cache_retention_once

    class _FakeEntailer:
        """Passes the loader's calibration gate without llama.cpp or weights."""

        def verify_calibration(self) -> None: ...

    # A cache already alive with a resident entailer (real load seam, fake GGUF).
    monkeypatch.setattr(minicheck_entailer, "_build_entailer", lambda _spec: _FakeEntailer())
    minicheck_entailer.load_minicheck_entailer(model_path="/staged/fake.gguf")
    assert minicheck_entailer.entailer_cache_stats().resident_models == 1

    served = {"ttl": 900}
    client = _client(lambda _r: httpx.Response(200, json=_payload(ttl_seconds=served["ttl"])))

    await _refresh_model_cache_retention_once(client)
    assert minicheck_entailer.entailer_cache_stats().ttl_seconds == 900

    served["ttl"] = 1800
    client.clear_cache()
    await _refresh_model_cache_retention_once(client)

    stats = minicheck_entailer.entailer_cache_stats()
    assert stats.ttl_seconds == 1800, "the live cache must follow later changes"
    assert stats.resident_models == 1, "reconfiguration must not drop the resident entailer"


# ── clause 3 — fail-safe ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gateway_unreachable_falls_back_to_env() -> None:
    from harness.sensors.inferential import minicheck_entailer
    from harness.temporal.worker import _refresh_model_cache_retention_once

    def boom(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("gateway unreachable")

    # Must NOT raise — housekeeping never takes the worker down mid-poll.
    await _refresh_model_cache_retention_once(_client(boom))

    assert minicheck_entailer.entailer_cache_stats().ttl_seconds == ENV_TTL_S


@pytest.mark.asyncio
async def test_absent_client_is_a_no_op() -> None:
    from harness.sensors.inferential import minicheck_entailer
    from harness.temporal.worker import _refresh_model_cache_retention_once

    await _refresh_model_cache_retention_once(None)

    assert minicheck_entailer.entailer_cache_stats().ttl_seconds == ENV_TTL_S


# ── clause 4 — the clamp is re-applied client-side ──────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(("served", "expected"), [(7200, 3600), (30, 60)])
async def test_clamp_applied_client_side(served: int, expected: int) -> None:
    from harness.sensors.inferential import minicheck_entailer
    from harness.temporal.worker import _refresh_model_cache_retention_once

    await _refresh_model_cache_retention_once(
        _client(lambda _r: httpx.Response(200, json=_payload(ttl_seconds=served)))
    )

    assert minicheck_entailer.entailer_cache_stats().ttl_seconds == expected


# ── §2.4 — process placement: the WORKER, never the FastAPI app ─────────────


@pytest.mark.asyncio
async def test_retention_refresh_runs_in_worker_process() -> None:
    """The refresh rides the worker's periodic loop, beside the model-cache sweep.

    Asserted three ways: the loop actually applies retention on one tick; the
    worker module owns the refresh; and the FastAPI app does NOT — a poll there
    would reconfigure a cache holding nothing, since the entailer is built by an
    activity in this process.
    """
    import inspect

    from harness.sensors.inferential import minicheck_entailer
    from harness.temporal import worker

    assert hasattr(worker, "_refresh_model_cache_retention_once")

    # One real housekeeping tick applies the control-plane value.
    await worker._model_cache_housekeeping_once(
        _client(lambda _r: httpx.Response(200, json=_payload(ttl_seconds=1500)))
    )

    assert minicheck_entailer.entailer_cache_stats().ttl_seconds == 1500

    # The periodic loop drives housekeeping (refresh + sweep together) and
    # builds its own client — so the refresh really is on the worker's path.
    loop_source = inspect.getsource(worker._sweep_model_caches_forever)
    assert "_model_cache_housekeeping_once" in loop_source
    assert "_effective_config_client" in loop_source

    # The FastAPI app must not install a retention refresher.
    import harness.main

    assert not hasattr(harness.main, "_refresh_model_cache_retention_once")
    assert "configure_entailer_cache" not in inspect.getsource(harness.main)
