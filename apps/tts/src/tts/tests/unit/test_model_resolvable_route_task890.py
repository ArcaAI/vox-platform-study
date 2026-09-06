"""TASK-890 J1 MAJOR-A — `/api/v1/internal/models/resolvable` on `apps/tts`.

The gateway used to decide a self-hosted model's usability from
`AiModel.availability`, a measurement of the `hope-models` MinIO bucket that
stamps MISSING on every row with a NULL `bucketPrefix`. TTS never reads that
bucket for its local voices: `kokoro` and `indic-parler-tts` resolve out of the
HuggingFace cache, so both reported "weights not available" whatever this host
actually held.

TTS is the service most often absent from a local stack, which is exactly why
this route reports a FACT and the gateway sweep owns the interpretation: no
answer means `unknown`, never a verdict. That half is asserted on the gateway
side; here we pin what the service itself promises — including, since TASK-890
F3, that it never calls `huggingface_hub` (whose no-download path still `open()`s
the external `HF_HOME` volume, and one of those parked a sibling service's event
loop for fifteen minutes) and that a stalled filesystem answers `resolvable:
null` inside a budget rather than wedging the request.

Hermetic: every test builds a real cache tree under `tmp_path` and points
`HF_HOME`/`HOME` at it, so no test touches the network or the host's own cache.
"""

from __future__ import annotations

import sys
import threading
import time
import types
from pathlib import Path
from typing import Any

import pytest
from hope_runtime_models import (
    ResolvableResult,
    clear_resolvable_cache,
    probe_state,
    reset_probe_state,
    reset_warmup_state,
    warm_cache_roots,
    warmup_state,
)
from httpx import ASGITransport, AsyncClient

ROUTE = "/api/v1/internal/models/resolvable"

SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"


def _stage(root: Path, repo_id: str, *, revision: str = "main") -> Path:
    """One repo in the real HuggingFace cache layout, with one materialised file."""
    storage = root / ("models--" + repo_id.replace("/", "--"))
    snapshot = storage / "snapshots" / SHA
    snapshot.mkdir(parents=True, exist_ok=True)
    (snapshot / "config.json").write_text("{}")
    (storage / "refs").mkdir(parents=True, exist_ok=True)
    (storage / "refs" / revision).write_text(SHA)
    return snapshot


def _never_returns(*_args: Any, **_kwargs: Any):
    """A filesystem read that outlives the budget — the F3 failure, simulated."""
    time.sleep(2)
    raise AssertionError("unreachable: the budget must have expired long before this")


@pytest.fixture(autouse=True)
def _fresh_cache():
    """Each test measures its own tree, not the previous test's memoised verdict.

    The probe-thread counts and the warm-up verdict are process-wide too
    (TASK-890 F6), so a test that stranded a worker would otherwise hand the
    next one a service that is already at its thread cap.
    """
    clear_resolvable_cache()
    reset_probe_state()
    reset_warmup_state()
    yield
    clear_resolvable_cache()
    reset_probe_state()
    reset_warmup_state()


@pytest.fixture
def gate():
    """One event every blocking worker waits on. Released in teardown, always."""
    event = threading.Event()
    yield event
    event.set()
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline and probe_state()[0] > 0:
        time.sleep(0.01)


def _selective(gate: threading.Event):
    """Blocks only on rows whose id starts with `stuck`; measures everything else."""

    def _check(query, *, hf_cache_dir=None, s3_cache_dir=None):  # noqa: ARG001
        if (query.id or "").startswith("stuck"):
            gate.wait(10)
        return ResolvableResult(query.id, True, "hf_cache", "measured", None)

    return _check


@pytest.fixture
def cache(tmp_path, monkeypatch) -> Path:
    """The dir the local voice runtimes load from: the hub default under `$HF_HOME`.

    `HOME` is redirected too — the resolver falls back to
    `~/.cache/huggingface/hub`, and a test that accidentally read the developer's
    real cache would pass for the wrong reason.
    """
    monkeypatch.setenv("HF_HOME", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    root = tmp_path / "hub"
    root.mkdir(parents=True, exist_ok=True)
    return root


@pytest.fixture(autouse=True)
def hub(monkeypatch):
    """A hub that explodes on contact — the no-hub clause, made falsifiable."""

    def _forbidden(*_args: Any, **_kwargs: Any):
        raise AssertionError("the resolvability probe must never call huggingface_hub")

    module = types.ModuleType("huggingface_hub")
    module.snapshot_download = _forbidden  # type: ignore[attr-defined]
    module.scan_cache_dir = _forbidden  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)
    return types.SimpleNamespace(forbidden=_forbidden)


@pytest.mark.asyncio
async def test_a_cached_snapshot_is_resolvable(async_client, cache):
    snapshot = _stage(cache, "hexgrad/Kokoro-82M")

    resp = await async_client.post(
        ROUTE, json={"models": [{"id": "m1", "sourceUri": "hexgrad/Kokoro-82M"}]}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["service"] == "tts"
    (result,) = body["results"]
    assert result["resolvable"] is True
    assert result["state"] == "hf_cache"
    assert result["path"] == str(snapshot)


@pytest.mark.asyncio
async def test_an_absent_snapshot_is_not_resolvable(async_client, cache):
    resp = await async_client.post(
        ROUTE, json={"models": [{"id": "m2", "sourceUri": "ai4bharat/indic-parler-tts"}]}
    )

    (result,) = resp.json()["results"]
    assert result["resolvable"] is False
    assert result["state"] == "not_cached"


@pytest.mark.asyncio
async def test_it_never_calls_the_hub(async_client, cache):
    """The `hub` fixture raises on contact; a 200 here is the whole assertion."""
    _stage(cache, "hexgrad/Kokoro-82M")

    resp = await async_client.post(
        ROUTE,
        json={
            "models": [
                {"id": "m3a", "sourceUri": "hexgrad/Kokoro-82M"},
                {"id": "m3b", "sourceUri": "ai4bharat/indic-parler-tts"},
            ]
        },
    )

    assert resp.status_code == 200
    assert [r["resolvable"] for r in resp.json()["results"]] == [True, False]


@pytest.mark.asyncio
async def test_the_stt_layout_under_hf_home_resolves_too(async_client, cache, tmp_path):
    """Both layouts are live on this host; reading one reports the other cold."""
    _stage(tmp_path, "hexgrad/Kokoro-82M")

    resp = await async_client.post(
        ROUTE, json={"models": [{"id": "m3c", "sourceUri": "hexgrad/Kokoro-82M"}]}
    )

    assert resp.json()["results"][0]["resolvable"] is True


@pytest.mark.asyncio
async def test_the_batch_answers_every_row_in_order(async_client, cache):
    _stage(cache, "a/one")

    resp = await async_client.post(
        ROUTE,
        json={"models": [{"id": "x", "sourceUri": "a/one"}, {"id": "y", "sourceUri": "b/two"}]},
    )

    results = resp.json()["results"]
    assert [r["id"] for r in results] == ["x", "y"]
    assert [r["resolvable"] for r in results] == [True, False]


@pytest.mark.asyncio
async def test_thirty_rows_answer_inside_a_second(async_client, cache):
    """The sweep asks about every self-hosted row at once, every cycle."""
    for index in range(15):
        _stage(cache, f"org{index}/repo")
    rows = [{"id": f"r{i}", "sourceUri": f"org{i}/repo"} for i in range(15)]
    rows += [{"id": f"a{i}", "sourceUri": f"absent{i}/repo"} for i in range(15)]

    started = time.perf_counter()
    resp = await async_client.post(ROUTE, json={"models": rows})
    elapsed = time.perf_counter() - started

    assert resp.status_code == 200
    assert len(resp.json()["results"]) == 30
    assert elapsed < 1.0, f"30 rows took {elapsed:.3f}s"


@pytest.mark.asyncio
async def test_a_stalled_filesystem_answers_rather_than_hanging(async_client, cache, monkeypatch):
    """The failure this route shipped with: one read that never returned.

    It parked the event loop and took the health probe with it. Now the read runs
    on a worker thread inside a budget, and a row that budget could not measure
    comes back `null` — recorded by the gateway as `unknown`, never as "weights
    missing".
    """
    import hope_runtime_models.resolvable as resolvable_module

    monkeypatch.setattr(resolvable_module, "_check", _never_returns)
    monkeypatch.setattr(resolvable_module, "DEFAULT_BUDGET_SECONDS", 0.2)

    started = time.perf_counter()
    resp = await async_client.post(
        ROUTE, json={"models": [{"id": "slow", "sourceUri": "org/repo"}]}
    )
    elapsed = time.perf_counter() - started

    assert resp.status_code == 200
    (result,) = resp.json()["results"]
    assert result["resolvable"] is None
    assert result["state"] == "timeout"
    assert elapsed < 5.0


def test_the_route_is_not_auth_exempt():
    """A deployed process must reject an unauthenticated probe."""
    from tts.api.middleware.auth import EXEMPT_PATHS

    assert ROUTE not in EXEMPT_PATHS


@pytest.mark.asyncio
async def test_an_unauthenticated_probe_is_401(monkeypatch):
    """The exempt-set check is necessary, not sufficient — prove the 401 fires."""
    from pydantic import SecretStr

    from tts.core.config import Settings
    from tts.tests.conftest import create_app

    token = "shared-internal-access-token-xyz"
    settings = Settings(
        host="127.0.0.1",
        port=5099,
        debug=True,
        log_level="debug",
        internal_access_token=SecretStr(token),
    )
    transport = ASGITransport(app=create_app(settings_override=settings))
    async with AsyncClient(transport=transport, base_url="http://test") as gated:
        assert (await gated.post(ROUTE, json={"models": []})).status_code == 401
        allowed = await gated.post(ROUTE, json={"models": []}, headers={"X-Service-Token": token})
        assert allowed.status_code == 200


@pytest.mark.asyncio
async def test_one_wedged_read_does_not_disable_the_next_request(
    async_client, cache, gate, monkeypatch
):
    """TASK-890 F6 — the failure the one-slot guard shipped with.

    F3 allowed exactly one probe at a time so a wedged filesystem read could
    strand at most one thread. Measured on a clean restart 2026-09-07, the FIRST
    wedged read then held the only slot for the life of the process and every
    later probe answered in 2 ms with `an earlier probe on this host has not
    returned` — up, and permanently unable to answer.
    """
    import hope_runtime_models.resolvable as resolvable_module

    monkeypatch.setattr(resolvable_module, "_check", _selective(gate))
    monkeypatch.setattr(resolvable_module, "DEFAULT_BUDGET_SECONDS", 0.2)

    stalled = await async_client.post(
        ROUTE, json={"models": [{"id": "stuck1", "sourceUri": "o/r"}]}
    )
    assert stalled.json()["results"][0]["state"] == "timeout"

    monkeypatch.setattr(resolvable_module, "DEFAULT_BUDGET_SECONDS", 5.0)
    measured = await async_client.post(ROUTE, json={"models": [{"id": "ok", "sourceUri": "o/r"}]})

    assert measured.json()["results"][0]["resolvable"] is True


@pytest.mark.asyncio
async def test_at_the_thread_cap_the_answer_is_degraded(async_client, cache, gate, monkeypatch):
    """Only when EVERY thread is wedged does the route stop measuring."""
    import hope_runtime_models.resolvable as resolvable_module

    monkeypatch.setattr(resolvable_module, "_check", _selective(gate))
    monkeypatch.setattr(resolvable_module, "DEFAULT_BUDGET_SECONDS", 0.2)
    for index in range(resolvable_module.MAX_PROBE_THREADS):
        await async_client.post(
            ROUTE, json={"models": [{"id": f"stuck{index}", "sourceUri": "o/r"}]}
        )

    resp = await async_client.post(ROUTE, json={"models": [{"id": "ok", "sourceUri": "o/r"}]})

    (result,) = resp.json()["results"]
    assert result["resolvable"] is None
    assert result["state"] == "degraded"
    assert "have not returned" in result["detail"]


@pytest.mark.asyncio
async def test_every_response_carries_the_boot_warm_up_verdict(async_client, cache, monkeypatch):
    """`pending` / `true` / `false` — the wiring, pinned deterministically.

    The real verdict is process-wide and the lifespan sets it from a detached
    task, so the value is stubbed here; that the field exists and carries
    exactly what the process believes is the part this route owns.
    """
    import tts.api.endpoints.models as route_module

    for value in ("pending", True, False):
        monkeypatch.setattr(route_module, "warmup_state", lambda v=value: v)
        resp = await async_client.post(ROUTE, json={"models": []})
        assert resp.json()["warm"] == value


@pytest.mark.asyncio
async def test_the_warm_up_state_is_true_once_the_roots_answer(async_client, cache):
    assert await warm_cache_roots(hf_cache_dir=str(cache), budget_seconds=10.0) is True

    resp = await async_client.get(ROUTE, params={"id": "m", "source_uri": "a/b"})

    assert resp.json()["warm"] is True
    assert warmup_state() is True
