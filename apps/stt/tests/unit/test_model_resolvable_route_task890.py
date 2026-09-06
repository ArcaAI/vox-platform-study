"""TASK-890 J1 MAJOR-A — `/api/v1/internal/models/resolvable` on `apps/stt`.

The gateway used to decide a self-hosted model's usability from
`AiModel.availability`, a measurement of the `hope-models` MinIO bucket that
stamps MISSING on every row with a NULL `bucketPrefix`. STT never reads that
bucket for those rows — `source_resolver.py` resolves `source_uri` into the
HuggingFace cache — so 21 of 33 catalogue rows, every whisper row included,
reported "weights not available" with the weights on this host's disk.

This route is the serving process's own answer. The suite pins the five things
that make it safe to act on:

  * a cached snapshot resolves and an absent one does not (the actual question);
  * NOTHING is fetched, and since TASK-890 F3 nothing calls `huggingface_hub` at
    all — the stub here raises if anything does. A readiness probe that
    downloads weights is a denial of service wearing a health check, and the
    hub's own no-download path still hung this service for fifteen minutes;
  * it reads the cache dir the LOADERS use (`huggingface_cache_dir`, which is
    `HF_HOME` itself, not `$HF_HOME/hub`) — reading the other one reports a warm
    cache as cold;
  * a stalled filesystem answers `resolvable: null` (NOT MEASURED) inside the
    budget rather than wedging the request, so the gateway keeps the row
    `unknown` instead of calling it missing;
  * it is service-token gated like every other non-exempt route.

Hermetic: every test builds a real cache tree under `tmp_path`, so no test ever
touches the network or the host's own cache.
"""

from __future__ import annotations

import sys
import time
import types
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
from hope_runtime_models import clear_resolvable_cache
from httpx import ASGITransport, AsyncClient

from tests.unit.test_hf_snapshot_resolver_task890 import stage_snapshot

ROUTE = "/api/v1/internal/models/resolvable"


def _never_returns(*_args: Any, **_kwargs: Any):
    """A filesystem read that outlives any budget — the F3 failure, simulated.

    Two seconds, not thirty: the point is that it outlives the budgets below, and
    the worker thread it strands is joined at interpreter exit, so a long sleep
    here is paid by every run of the whole suite.
    """
    time.sleep(2)
    raise AssertionError("unreachable: the budget must have expired long before this")


def _settings(**overrides: Any):
    from stt.core.config.settings import Settings

    return Settings(metrics_enabled=False, otel_enabled=False, **overrides)


@pytest.fixture(autouse=True)
def _no_token(monkeypatch):
    """Local-dev bypass, so these tests are about resolvability, not auth."""
    monkeypatch.delenv("INTERNAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)


@pytest.fixture(autouse=True)
def _fresh_cache():
    """Each test measures its own tree, not the previous test's memoised verdict."""
    clear_resolvable_cache()
    yield
    clear_resolvable_cache()


@pytest.fixture
def cache(tmp_path) -> Path:
    """The dir STT's own resolver is handed: `huggingface_cache_dir` verbatim."""
    root = tmp_path / "hf"
    root.mkdir()
    return root


@pytest_asyncio.fixture
async def client(cache, monkeypatch):
    from stt.main import create_app

    app = create_app(settings_override=_settings(huggingface_cache_dir=str(cache)))
    monkeypatch.setattr("stt.models.resolvable_routes.get_settings", lambda: app.state.settings)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def hub(monkeypatch):
    """A hub that explodes on contact.

    TASK-890 F3: `snapshot_download(local_files_only=True)` is not a download,
    but it IS an `open()` on the external `HF_HOME` volume, and one of those
    parked this service's event loop for fifteen minutes. The probe now reads the
    cache layout itself, and this stub is what makes "it never calls the hub"
    falsifiable rather than aspirational.
    """

    def _forbidden(*_args: Any, **_kwargs: Any):
        raise AssertionError("the resolvability probe must never call huggingface_hub")

    module = types.ModuleType("huggingface_hub")
    module.snapshot_download = _forbidden  # type: ignore[attr-defined]
    module.scan_cache_dir = _forbidden  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)
    return types.SimpleNamespace(forbidden=_forbidden)


class TestResolvableRoute:
    @pytest.mark.asyncio
    async def test_a_cached_snapshot_is_resolvable(self, client, cache):
        snapshot = stage_snapshot(cache, "blaze999/Medical-NER")

        resp = await client.post(
            ROUTE, json={"models": [{"id": "m1", "sourceUri": "blaze999/Medical-NER"}]}
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["service"] == "stt"
        assert body["checkedAt"]
        (result,) = body["results"]
        assert result == {
            "id": "m1",
            "resolvable": True,
            "state": "hf_cache",
            "detail": "a snapshot is present in the local HuggingFace cache",
            "path": str(snapshot),
        }

    @pytest.mark.asyncio
    async def test_an_absent_snapshot_is_not_resolvable(self, client):
        resp = await client.post(
            ROUTE, json={"models": [{"id": "m2", "sourceUri": "openai/whisper-large-v3"}]}
        )

        (result,) = resp.json()["results"]
        assert result["resolvable"] is False
        assert result["state"] == "not_cached"
        assert result["path"] is None

    @pytest.mark.asyncio
    async def test_it_never_calls_the_hub(self, client, cache):
        """The `hub` fixture raises on contact; a 200 here is the whole assertion."""
        stage_snapshot(cache, "blaze999/Medical-NER")

        resp = await client.post(
            ROUTE,
            json={
                "models": [
                    {"id": "m3a", "sourceUri": "blaze999/Medical-NER"},
                    {"id": "m3b", "sourceUri": "openai/whisper-large-v3"},
                ]
            },
        )

        assert resp.status_code == 200
        assert [r["resolvable"] for r in resp.json()["results"]] == [True, False]

    @pytest.mark.asyncio
    async def test_it_reads_the_cache_dir_the_loaders_use(self, client, cache, tmp_path):
        """`huggingface_cache_dir`, NOT the hub's own `$HF_HOME/hub` default.

        `source_resolver.config_from_settings` passes exactly this value, so a
        repo staged anywhere else is not a repo this process can load.
        """
        stage_snapshot(tmp_path / "somewhere-else", "openai/whisper-large-v3")

        resp = await client.post(
            ROUTE, json={"models": [{"id": "m4", "sourceUri": "openai/whisper-large-v3"}]}
        )
        assert resp.json()["results"][0]["resolvable"] is False

        stage_snapshot(cache, "openai/whisper-large-v3")
        clear_resolvable_cache()
        resp = await client.post(
            ROUTE, json={"models": [{"id": "m4", "sourceUri": "openai/whisper-large-v3"}]}
        )
        assert resp.json()["results"][0]["resolvable"] is True

    @pytest.mark.asyncio
    async def test_the_hub_layout_under_that_dir_resolves_too(self, client, cache):
        """Both layouts are live on this host; reading one reports the other cold."""
        stage_snapshot(cache / "hub", "onnx-community/silero-vad")

        resp = await client.post(
            ROUTE, json={"models": [{"id": "m4b", "sourceUri": "onnx-community/silero-vad"}]}
        )

        assert resp.json()["results"][0]["resolvable"] is True

    @pytest.mark.asyncio
    async def test_a_package_provided_library_needs_no_artifact(self, client):
        resp = await client.post(
            ROUTE,
            json={"models": [{"id": "m5", "sourceUri": "pypi:pyrnnoise", "library": "pyrnnoise"}]},
        )

        (result,) = resp.json()["results"]
        # `pyrnnoise` is a declared STT dependency, so it is installed wherever
        # this suite runs; the row's `source_uri` is not a fetchable scheme and
        # must not be treated as one.
        assert result["resolvable"] is True
        assert result["state"] == "package"

    @pytest.mark.asyncio
    async def test_an_unknown_scheme_is_named_rather_than_guessed(self, client):
        resp = await client.post(
            ROUTE,
            json={
                "models": [
                    {"id": "m6", "sourceUri": "github:Rikorose/DeepFilterNet#DeepFilterNet3"}
                ]
            },
        )

        (result,) = resp.json()["results"]
        assert result["resolvable"] is False
        assert result["state"] == "unsupported"

    @pytest.mark.asyncio
    async def test_a_row_with_no_source_is_not_resolvable(self, client):
        resp = await client.post(ROUTE, json={"models": [{"id": "m7"}]})

        (result,) = resp.json()["results"]
        assert result["resolvable"] is False
        assert result["state"] == "no_source"

    @pytest.mark.asyncio
    async def test_the_single_row_GET_answers_the_same_question(self, client, cache):
        stage_snapshot(cache, "blaze999/Medical-NER")

        resp = await client.get(ROUTE, params={"id": "m8", "source_uri": "blaze999/Medical-NER"})

        assert resp.status_code == 200
        assert resp.json()["result"]["resolvable"] is True

    @pytest.mark.asyncio
    async def test_the_batch_answers_every_row_in_order(self, client, cache):
        stage_snapshot(cache, "a/one")

        resp = await client.post(
            ROUTE,
            json={"models": [{"id": "x", "sourceUri": "a/one"}, {"id": "y", "sourceUri": "b/two"}]},
        )

        results = resp.json()["results"]
        assert [r["id"] for r in results] == ["x", "y"]
        assert [r["resolvable"] for r in results] == [True, False]

    @pytest.mark.asyncio
    async def test_thirty_rows_answer_inside_a_second(self, client, cache):
        """The sweep asks about every self-hosted row at once, every cycle."""
        for index in range(15):
            stage_snapshot(cache, f"org{index}/repo")
        rows = [{"id": f"r{i}", "sourceUri": f"org{i}/repo"} for i in range(15)]
        rows += [{"id": f"a{i}", "sourceUri": f"absent{i}/repo"} for i in range(15)]

        started = time.perf_counter()
        resp = await client.post(ROUTE, json={"models": rows})
        elapsed = time.perf_counter() - started

        assert resp.status_code == 200
        assert len(resp.json()["results"]) == 30
        assert elapsed < 1.0, f"30 rows took {elapsed:.3f}s"

    @pytest.mark.asyncio
    async def test_a_stalled_filesystem_answers_rather_than_hanging(self, client, monkeypatch):
        """The failure this route shipped with: one read that never returned.

        It parked the event loop and took the health probe with it. Now the read
        happens on a worker thread inside a budget, and a row that budget could
        not measure comes back `null` — which the gateway records as `unknown`,
        never as "weights missing".
        """
        import hope_runtime_models.resolvable as resolvable_module

        monkeypatch.setattr(resolvable_module, "_check", _never_returns)
        monkeypatch.setattr(resolvable_module, "DEFAULT_BUDGET_SECONDS", 0.2)

        started = time.perf_counter()
        resp = await client.post(ROUTE, json={"models": [{"id": "slow", "sourceUri": "org/repo"}]})
        elapsed = time.perf_counter() - started

        assert resp.status_code == 200
        (result,) = resp.json()["results"]
        assert result["resolvable"] is None
        assert result["state"] == "timeout"
        assert elapsed < 5.0

    @pytest.mark.asyncio
    async def test_the_health_probe_still_answers_during_a_stalled_check(self, client, monkeypatch):
        """The clause that matters operationally: the service survives its own probe."""
        import asyncio

        import hope_runtime_models.resolvable as resolvable_module

        monkeypatch.setattr(resolvable_module, "_check", _never_returns)
        monkeypatch.setattr(resolvable_module, "DEFAULT_BUDGET_SECONDS", 1.0)

        probe = asyncio.ensure_future(
            client.post(ROUTE, json={"models": [{"id": "slow", "sourceUri": "org/repo"}]})
        )
        await asyncio.sleep(0.2)
        health = await client.get("/api/v1/health")
        await probe

        assert health.status_code == 200


class TestResolvableRouteIsGated:
    @pytest.mark.asyncio
    async def test_it_is_not_in_the_auth_exempt_set(self, monkeypatch):
        """A deployed process must reject an unauthenticated probe."""
        from stt.core.middleware.auth import EXEMPT_PATHS

        assert ROUTE not in EXEMPT_PATHS

        monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "shared-internal-access-token-xyz")
        from stt.main import create_app

        app = create_app(settings_override=_settings())
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            unauthenticated = await c.post(ROUTE, json={"models": []})
            authenticated = await c.post(
                ROUTE,
                json={"models": []},
                headers={"X-Service-Token": "shared-internal-access-token-xyz"},
            )

        assert unauthenticated.status_code == 401
        assert authenticated.status_code == 200
