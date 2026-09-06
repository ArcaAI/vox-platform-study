"""TASK-890 J1 MAJOR-A — `/api/v1/internal/models/resolvable` on `apps/nlp`.

The gateway used to decide a self-hosted model's usability from
`AiModel.availability`, a measurement of the `hope-models` MinIO bucket that
stamps MISSING on every row with a NULL `bucketPrefix`. NLP never reads that
bucket — `medical-ner`, the three `gliner2` rows and `symps-disease-bert` resolve
out of the HuggingFace cache under `HF_HOME` — so all five reported "weights not
available" while the weights sat on this host's disk.

The clauses pinned here are the ones that make the answer safe to act on: a
cached snapshot resolves and an absent one does not; NOTHING is fetched, and
since TASK-890 F3 nothing calls `huggingface_hub` at ALL (its no-download path
still `open()`s the external `HF_HOME` volume, and one of those parked this
service's event loop for fifteen minutes); the cache dir is the PROCESS default,
so `$HF_HOME/hub` — where NLP's loaders put weights — is read, as well as
`HF_HOME` itself, which is what STT's own resolver is handed; and a stalled
filesystem answers `resolvable: null` inside a budget rather than wedging the
request.

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
    """The dir NLP's loaders use: the hub default under `$HF_HOME`.

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


def test_a_cached_snapshot_is_resolvable(client, cache):
    snapshot = _stage(cache, "blaze999/Medical-NER")

    resp = client.post(ROUTE, json={"models": [{"id": "m1", "sourceUri": "blaze999/Medical-NER"}]})

    assert resp.status_code == 200
    body = resp.json()
    assert body["service"] == "nlp"
    (result,) = body["results"]
    assert result["resolvable"] is True
    assert result["state"] == "hf_cache"
    assert result["path"] == str(snapshot)


def test_an_absent_snapshot_is_not_resolvable(client, cache):
    resp = client.post(
        ROUTE, json={"models": [{"id": "m2", "sourceUri": "fastino/GLiNER2-Guardrails-PII-Multi"}]}
    )

    (result,) = resp.json()["results"]
    assert result["resolvable"] is False
    assert result["state"] == "not_cached"


def test_it_never_calls_the_hub(client, cache):
    """The `hub` fixture raises on contact; a 200 here is the whole assertion."""
    _stage(cache, "blaze999/Medical-NER")

    resp = client.post(
        ROUTE,
        json={
            "models": [
                {"id": "m3a", "sourceUri": "blaze999/Medical-NER"},
                {"id": "m3b", "sourceUri": "fastino/GLiNER2-Guardrails-PII-Multi"},
            ]
        },
    )

    assert resp.status_code == 200
    assert [r["resolvable"] for r in resp.json()["results"]] == [True, False]


def test_it_reads_the_process_default_cache(client, cache, tmp_path):
    """`cache_dir=None` — `$HF_HOME/hub` is where NLP's loaders put weights."""
    resp = client.post(
        ROUTE, json={"models": [{"id": "m4", "sourceUri": "fastino/GLiNER2-Guardrails-PII-Multi"}]}
    )
    assert resp.json()["results"][0]["resolvable"] is False

    _stage(cache, "fastino/GLiNER2-Guardrails-PII-Multi")
    clear_resolvable_cache()
    resp = client.post(
        ROUTE, json={"models": [{"id": "m4", "sourceUri": "fastino/GLiNER2-Guardrails-PII-Multi"}]}
    )
    assert resp.json()["results"][0]["resolvable"] is True


def test_the_stt_layout_under_hf_home_resolves_too(client, cache, tmp_path):
    """`HF_HOME` itself is a live layout on this host — STT's resolver is handed it.

    Reading only one of the two reports a warm cache as cold, which is the bug
    this route exists to fix; it must not be reintroduced one directory up.
    """
    _stage(tmp_path, "blaze999/Medical-NER")

    resp = client.post(ROUTE, json={"models": [{"id": "m4b", "sourceUri": "blaze999/Medical-NER"}]})

    assert resp.json()["results"][0]["resolvable"] is True


def test_an_unknown_scheme_is_named_rather_than_guessed(client, cache):
    resp = client.post(
        ROUTE,
        json={
            "models": [{"id": "m5", "sourceUri": "github:Rikorose/DeepFilterNet#DeepFilterNet3"}]
        },
    )

    (result,) = resp.json()["results"]
    assert result["resolvable"] is False
    assert result["state"] == "unsupported"


def test_the_single_row_GET_answers_the_same_question(client, cache):
    _stage(cache, "blaze999/Medical-NER")

    resp = client.get(ROUTE, params={"id": "m6", "source_uri": "blaze999/Medical-NER"})

    assert resp.status_code == 200
    assert resp.json()["result"]["resolvable"] is True


def test_the_batch_answers_every_row_in_order(client, cache):
    _stage(cache, "a/one")

    resp = client.post(
        ROUTE,
        json={"models": [{"id": "x", "sourceUri": "a/one"}, {"id": "y", "sourceUri": "b/two"}]},
    )

    results = resp.json()["results"]
    assert [r["id"] for r in results] == ["x", "y"]
    assert [r["resolvable"] for r in results] == [True, False]


def test_thirty_rows_answer_inside_a_second(client, cache):
    """The sweep asks about every self-hosted row at once, every cycle."""
    for index in range(15):
        _stage(cache, f"org{index}/repo")
    rows = [{"id": f"r{i}", "sourceUri": f"org{i}/repo"} for i in range(15)]
    rows += [{"id": f"a{i}", "sourceUri": f"absent{i}/repo"} for i in range(15)]

    started = time.perf_counter()
    resp = client.post(ROUTE, json={"models": rows})
    elapsed = time.perf_counter() - started

    assert resp.status_code == 200
    assert len(resp.json()["results"]) == 30
    assert elapsed < 1.0, f"30 rows took {elapsed:.3f}s"


def test_a_stalled_filesystem_answers_rather_than_hanging(client, cache, monkeypatch):
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
    resp = client.post(ROUTE, json={"models": [{"id": "slow", "sourceUri": "org/repo"}]})
    elapsed = time.perf_counter() - started

    assert resp.status_code == 200
    (result,) = resp.json()["results"]
    assert result["resolvable"] is None
    assert result["state"] == "timeout"
    assert elapsed < 5.0


def test_the_route_is_not_auth_exempt():
    """A deployed process must reject an unauthenticated probe."""
    from nlp.api.middleware.auth import EXEMPT_PATHS

    assert ROUTE not in EXEMPT_PATHS


def test_an_unauthenticated_probe_is_401(client, monkeypatch):
    """The exempt-set check is necessary, not sufficient — prove the 401 fires.

    `accepted_service_tokens` admits only the canonical shared
    `internal_access_token`, and the `client` fixture blanks it so the handler
    suites above can run header-less; pinning it back here is what turns the
    route's gate on.
    """
    from pydantic import SecretStr

    from nlp.core.config import settings as nlp_settings

    token = "shared-internal-access-token-xyz"
    monkeypatch.setattr(
        nlp_settings.service, "internal_access_token", SecretStr(token), raising=False
    )

    assert client.post(ROUTE, json={"models": []}).status_code == 401
    assert (
        client.post(ROUTE, json={"models": []}, headers={"X-Service-Token": token}).status_code
        == 200
    )


def test_one_wedged_read_does_not_disable_the_next_request(client, cache, gate, monkeypatch):
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

    stalled = client.post(ROUTE, json={"models": [{"id": "stuck1", "sourceUri": "o/r"}]})
    assert stalled.json()["results"][0]["state"] == "timeout"

    monkeypatch.setattr(resolvable_module, "DEFAULT_BUDGET_SECONDS", 5.0)
    measured = client.post(ROUTE, json={"models": [{"id": "ok", "sourceUri": "o/r"}]})

    assert measured.json()["results"][0]["resolvable"] is True


def test_at_the_thread_cap_the_answer_is_degraded(client, cache, gate, monkeypatch):
    """Only when EVERY thread is wedged does the route stop measuring."""
    import hope_runtime_models.resolvable as resolvable_module

    monkeypatch.setattr(resolvable_module, "_check", _selective(gate))
    monkeypatch.setattr(resolvable_module, "DEFAULT_BUDGET_SECONDS", 0.2)
    for index in range(resolvable_module.MAX_PROBE_THREADS):
        client.post(ROUTE, json={"models": [{"id": f"stuck{index}", "sourceUri": "o/r"}]})

    resp = client.post(ROUTE, json={"models": [{"id": "ok", "sourceUri": "o/r"}]})

    (result,) = resp.json()["results"]
    assert result["resolvable"] is None
    assert result["state"] == "degraded"
    assert "have not returned" in result["detail"]


def test_every_response_carries_the_boot_warm_up_verdict(client, cache, monkeypatch):
    """`pending` / `true` / `false` — the wiring, pinned deterministically.

    The real verdict is process-wide and the lifespan sets it from a detached
    task, so the value is stubbed here; that the field exists and carries
    exactly what the process believes is the part this route owns.
    """
    import nlp.api.v1.rest.models as route_module

    for value in ("pending", True, False):
        monkeypatch.setattr(route_module, "warmup_state", lambda v=value: v)
        assert client.post(ROUTE, json={"models": []}).json()["warm"] == value


async def test_the_warm_up_state_is_true_once_the_roots_answer(client, cache):
    assert await warm_cache_roots(hf_cache_dir=str(cache), budget_seconds=10.0) is True

    resp = client.get(ROUTE, params={"id": "m", "source_uri": "a/b"})

    assert resp.json()["warm"] is True
    assert warmup_state() is True
