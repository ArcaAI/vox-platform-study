"""TASK-890 J1 MAJOR-A — `/api/v1/internal/models/resolvable` on `apps/nlp`.

The gateway used to decide a self-hosted model's usability from
`AiModel.availability`, a measurement of the `hope-models` MinIO bucket that
stamps MISSING on every row with a NULL `bucketPrefix`. NLP never reads that
bucket — `medical-ner`, the three `gliner2` rows and `symps-disease-bert` resolve
out of the HuggingFace cache under `HF_HOME` — so all five reported "weights not
available" while the weights sat on this host's disk.

The clauses pinned here are the ones that make the answer safe to act on: a
cached snapshot resolves and an absent one does not; NOTHING is fetched; and the
cache dir is the PROCESS default, because NLP loads through the hub library
(`$HF_HOME/hub`) rather than through a resolver that is handed `HF_HOME` itself
the way STT's is.

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


def test_a_cached_snapshot_is_resolvable(client, hub):
    hub.cached.add("blaze999/Medical-NER")

    resp = client.post(ROUTE, json={"models": [{"id": "m1", "sourceUri": "blaze999/Medical-NER"}]})

    assert resp.status_code == 200
    body = resp.json()
    assert body["service"] == "nlp"
    (result,) = body["results"]
    assert result["resolvable"] is True
    assert result["state"] == "hf_cache"
    assert result["path"] == "/cache/blaze999--Medical-NER"


def test_an_absent_snapshot_is_not_resolvable(client, hub):
    resp = client.post(
        ROUTE, json={"models": [{"id": "m2", "sourceUri": "fastino/GLiNER2-Guardrails-PII-Multi"}]}
    )

    (result,) = resp.json()["results"]
    assert result["resolvable"] is False
    assert result["state"] == "not_cached"


def test_it_never_downloads(client, hub):
    client.post(
        ROUTE, json={"models": [{"id": "m3", "sourceUri": "fastino/GLiNER2-Guardrails-PII-Multi"}]}
    )

    assert hub.calls, "the hub was never consulted"
    for call in hub.calls:
        assert call["local_files_only"] is True, "a readiness probe must never fetch weights"


def test_it_reads_the_process_default_cache(client, hub):
    """`cache_dir=None` — the hub resolves `$HF_HOME/hub`, which is where NLP's
    loaders put weights. STT is the one service that must pass `HF_HOME` itself,
    because its own resolver does; copying that here would read the wrong dir."""
    client.post(
        ROUTE, json={"models": [{"id": "m4", "sourceUri": "fastino/GLiNER2-Guardrails-PII-Multi"}]}
    )

    assert hub.calls[0]["cache_dir"] is None


def test_an_unknown_scheme_is_named_rather_than_guessed(client, hub):
    resp = client.post(
        ROUTE,
        json={
            "models": [{"id": "m5", "sourceUri": "github:Rikorose/DeepFilterNet#DeepFilterNet3"}]
        },
    )

    (result,) = resp.json()["results"]
    assert result["resolvable"] is False
    assert result["state"] == "unsupported"


def test_the_single_row_GET_answers_the_same_question(client, hub):
    hub.cached.add("blaze999/Medical-NER")

    resp = client.get(ROUTE, params={"id": "m6", "source_uri": "blaze999/Medical-NER"})

    assert resp.status_code == 200
    assert resp.json()["result"]["resolvable"] is True


def test_the_batch_answers_every_row_in_order(client, hub):
    hub.cached.add("a/one")

    resp = client.post(
        ROUTE,
        json={"models": [{"id": "x", "sourceUri": "a/one"}, {"id": "y", "sourceUri": "b/two"}]},
    )

    results = resp.json()["results"]
    assert [r["id"] for r in results] == ["x", "y"]
    assert [r["resolvable"] for r in results] == [True, False]


def test_the_route_is_not_auth_exempt():
    """A deployed process must reject an unauthenticated probe."""
    from nlp.api.middleware.auth import EXEMPT_PATHS

    assert ROUTE not in EXEMPT_PATHS
