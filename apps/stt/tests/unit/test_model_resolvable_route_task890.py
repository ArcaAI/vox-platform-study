"""TASK-890 J1 MAJOR-A — `/api/v1/internal/models/resolvable` on `apps/stt`.

The gateway used to decide a self-hosted model's usability from
`AiModel.availability`, a measurement of the `hope-models` MinIO bucket that
stamps MISSING on every row with a NULL `bucketPrefix`. STT never reads that
bucket for those rows — `source_resolver.py` resolves `source_uri` into the
HuggingFace cache — so 21 of 33 catalogue rows, every whisper row included,
reported "weights not available" with the weights on this host's disk.

This route is the serving process's own answer. The suite pins the four things
that make it safe to act on:

  * a cached snapshot resolves and an absent one does not (the actual question);
  * NOTHING is fetched — `local_files_only` is what the hub call must carry,
    because a readiness probe that downloads weights is a denial of service
    wearing a health check;
  * it reads the cache dir the LOADERS use (`huggingface_cache_dir`, which is
    `HF_HOME` itself, not `$HF_HOME/hub`) — reading the other one reports a warm
    cache as cold;
  * it is service-token gated like every other non-exempt route.

Hermetic: the hub is stubbed, so no test ever touches the network or a real
cache.
"""

from __future__ import annotations

from typing import Any

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

ROUTE = "/api/v1/internal/models/resolvable"


def _settings(**overrides: Any):
    from stt.core.config.settings import Settings

    return Settings(metrics_enabled=False, otel_enabled=False, **overrides)


@pytest.fixture(autouse=True)
def _no_token(monkeypatch):
    """Local-dev bypass, so these tests are about resolvability, not auth."""
    monkeypatch.delenv("INTERNAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    from stt.main import create_app

    app = create_app(settings_override=_settings(huggingface_cache_dir=str(tmp_path / "hf")))
    monkeypatch.setattr("stt.models.resolvable_routes.get_settings", lambda: app.state.settings)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def hub(monkeypatch):
    """A stub hub. Records every call so the no-download clause is falsifiable."""
    calls: list[dict[str, Any]] = []
    cached: set[str] = set()

    def _snapshot_download(**kwargs: Any) -> str:
        calls.append(kwargs)
        repo_id = kwargs["repo_id"]
        if repo_id not in cached:
            raise FileNotFoundError(f"{repo_id} is not in the local cache")
        return f"/cache/{repo_id.replace('/', '--')}"

    import sys
    import types

    module = types.ModuleType("huggingface_hub")
    module.snapshot_download = _snapshot_download  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)
    return types.SimpleNamespace(calls=calls, cached=cached)


class TestResolvableRoute:
    @pytest.mark.asyncio
    async def test_a_cached_snapshot_is_resolvable(self, client, hub):
        hub.cached.add("blaze999/Medical-NER")

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
            "path": "/cache/blaze999--Medical-NER",
        }

    @pytest.mark.asyncio
    async def test_an_absent_snapshot_is_not_resolvable(self, client, hub):
        resp = await client.post(
            ROUTE, json={"models": [{"id": "m2", "sourceUri": "openai/whisper-large-v3"}]}
        )

        (result,) = resp.json()["results"]
        assert result["resolvable"] is False
        assert result["state"] == "not_cached"
        assert result["path"] is None

    @pytest.mark.asyncio
    async def test_it_never_downloads(self, client, hub):
        await client.post(
            ROUTE, json={"models": [{"id": "m3", "sourceUri": "openai/whisper-large-v3"}]}
        )

        assert hub.calls, "the hub was never consulted"
        for call in hub.calls:
            assert call["local_files_only"] is True, "a readiness probe must never fetch weights"

    @pytest.mark.asyncio
    async def test_it_reads_the_cache_dir_the_loaders_use(self, client, hub, tmp_path):
        await client.post(
            ROUTE, json={"models": [{"id": "m4", "sourceUri": "openai/whisper-large-v3"}]}
        )

        # `huggingface_cache_dir`, NOT the hub's own `$HF_HOME/hub` default:
        # `source_resolver.config_from_settings` passes exactly this value.
        assert hub.calls[0]["cache_dir"] == str(tmp_path / "hf")

    @pytest.mark.asyncio
    async def test_a_package_provided_library_needs_no_artifact(self, client, hub):
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
    async def test_an_unknown_scheme_is_named_rather_than_guessed(self, client, hub):
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
    async def test_a_row_with_no_source_is_not_resolvable(self, client, hub):
        resp = await client.post(ROUTE, json={"models": [{"id": "m7"}]})

        (result,) = resp.json()["results"]
        assert result["resolvable"] is False
        assert result["state"] == "no_source"

    @pytest.mark.asyncio
    async def test_the_single_row_GET_answers_the_same_question(self, client, hub):
        hub.cached.add("blaze999/Medical-NER")

        resp = await client.get(ROUTE, params={"id": "m8", "source_uri": "blaze999/Medical-NER"})

        assert resp.status_code == 200
        assert resp.json()["result"]["resolvable"] is True

    @pytest.mark.asyncio
    async def test_the_batch_answers_every_row_in_order(self, client, hub):
        hub.cached.add("a/one")

        resp = await client.post(
            ROUTE,
            json={"models": [{"id": "x", "sourceUri": "a/one"}, {"id": "y", "sourceUri": "b/two"}]},
        )

        results = resp.json()["results"]
        assert [r["id"] for r in results] == ["x", "y"]
        assert [r["resolvable"] for r in results] == [True, False]


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
