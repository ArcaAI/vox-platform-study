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
side; here we pin what the service itself promises.

Hermetic: the hub is stubbed, so no test touches the network or a real cache.
"""

from __future__ import annotations

import sys
import types
from typing import Any

import pytest

ROUTE = "/api/v1/internal/models/resolvable"


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

    module = types.ModuleType("huggingface_hub")
    module.snapshot_download = _snapshot_download  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)
    return types.SimpleNamespace(calls=calls, cached=cached)


@pytest.mark.asyncio
async def test_a_cached_snapshot_is_resolvable(async_client, hub):
    hub.cached.add("hexgrad/Kokoro-82M")

    resp = await async_client.post(
        ROUTE, json={"models": [{"id": "m1", "sourceUri": "hexgrad/Kokoro-82M"}]}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["service"] == "tts"
    (result,) = body["results"]
    assert result["resolvable"] is True
    assert result["state"] == "hf_cache"


@pytest.mark.asyncio
async def test_an_absent_snapshot_is_not_resolvable(async_client, hub):
    resp = await async_client.post(
        ROUTE, json={"models": [{"id": "m2", "sourceUri": "ai4bharat/indic-parler-tts"}]}
    )

    (result,) = resp.json()["results"]
    assert result["resolvable"] is False
    assert result["state"] == "not_cached"


@pytest.mark.asyncio
async def test_it_never_downloads(async_client, hub):
    await async_client.post(
        ROUTE, json={"models": [{"id": "m3", "sourceUri": "ai4bharat/indic-parler-tts"}]}
    )

    assert hub.calls, "the hub was never consulted"
    for call in hub.calls:
        assert call["local_files_only"] is True, "a readiness probe must never fetch weights"


@pytest.mark.asyncio
async def test_the_batch_answers_every_row_in_order(async_client, hub):
    hub.cached.add("a/one")

    resp = await async_client.post(
        ROUTE,
        json={"models": [{"id": "x", "sourceUri": "a/one"}, {"id": "y", "sourceUri": "b/two"}]},
    )

    results = resp.json()["results"]
    assert [r["id"] for r in results] == ["x", "y"]
    assert [r["resolvable"] for r in results] == [True, False]


def test_the_route_is_not_auth_exempt():
    """A deployed process must reject an unauthenticated probe."""
    from tts.api.middleware.auth import EXEMPT_PATHS

    assert ROUTE not in EXEMPT_PATHS
