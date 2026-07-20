"""Phase B — lazy, DB-selected aux models with idle-TTL/eviction.

Proves the owner expectations for the guardrail auxiliary models:

* a freshly-booted worker holds NO GLiNER weights (the lifespan loads nothing);
* the first ``/guardrail/analyze`` lazily loads GLiNER exactly once (single-flight),
  keyed by the DB-resolved runtime model id;
* the idle-TTL cache clamps to [60s, 3600s], evicts idle (unpinned) models, and a
  pin blocks eviction;
* a MISSING ``guardrail.safety`` / ``guardrail.groundedness`` DB selection fails
  CLOSED with HTTP 503 (no env fallback for model IDENTITY);
* the groundedness gate resolves its MiniCheck model id from DB.

All hermetic: the real ONNX / GGUF backends are never touched — fake providers /
scorers are injected through the aux ``ModelCache`` factory and a stub DB resolver.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Sequence
from typing import Any

import fakeredis.aioredis
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from guardrail.core.config import GroundednessConfig
from guardrail.main import create_app
from guardrail.services.model_cache import (
    DEFAULT_TTL_SECONDS,
    ModelCache,
    clamp_cache_ttl_seconds,
)

GLINER_MODEL_ID = "hivetrace/gliner-guard-uniencoder-onnx"
MINICHECK_MODEL_ID = "nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF"

TRANSCRIPT = "Patient reports a persistent dry cough for two weeks."
SUPPORTED_CLAIM = "Patient reports a persistent dry cough."


# ── Test doubles ──────────────────────────────────────────────────────────


class _Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


class FakeGliner:
    """Lightweight GLiNER stand-in — no ONNX weights."""

    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        self.shutdown_called = False

    async def analyze_content(
        self, text: str, guardrail_type: str = "comprehensive"
    ) -> dict[str, Any]:
        return {"safe": True, "issues": [], "confidence": 1.0}

    def shutdown(self) -> None:
        self.shutdown_called = True


class KeywordOverlapScorer:
    """Deterministic tiny stand-in NLI scorer (mirrors the endpoint test)."""

    def score_pairs(self, pairs: Sequence[tuple[str, str]]) -> Sequence[float]:
        scores: list[float] = []
        for source, claim in pairs:
            source_words = set(re.findall(r"[a-z0-9]+", source.lower()))
            claim_words = [w for w in re.findall(r"[a-z0-9]+", claim.lower()) if len(w) > 2]
            scores.append(
                sum(1 for w in claim_words if w in source_words) / len(claim_words)
                if claim_words
                else 0.0
            )
        return scores


class StubResolver:
    """Resolves ``resolve_model_id`` to a fixed value (or ``None`` = missing)."""

    def __init__(self, model_id: str | None) -> None:
        self._model_id = model_id
        self.seen: list[tuple[str | None, str]] = []

    async def resolve_model_id(self, tenant_id: str | None, task_key: str) -> str | None:
        self.seen.append((tenant_id, task_key))
        return self._model_id


async def _post(app: FastAPI, path: str, body: dict[str, Any]) -> Any:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post(path, json=body)


# ── ModelCache: TTL clamp, lazy load, single-flight, idle eviction, pinning ─


def test_ttl_is_clamped_to_product_window() -> None:
    assert clamp_cache_ttl_seconds(5) == 60  # below floor
    assert clamp_cache_ttl_seconds(120) == 120  # within window
    assert clamp_cache_ttl_seconds(999_999) == 3600  # above ceiling
    # TASK-529 / OD-5: the bootstrap default moved 3600 → 600. The product
    # WINDOW is unchanged (a 1 h maximum is still enforced above); only the
    # default inside it changed. Deliberate, owner-approved behaviour change.
    assert DEFAULT_TTL_SECONDS == 600


async def test_cache_loads_lazily_and_caches() -> None:
    loads: list[str] = []

    async def factory(model_id: str) -> object:
        loads.append(model_id)
        return object()

    cache: ModelCache[object] = ModelCache(factory=factory, ttl_seconds=60)
    assert cache.cached_models() == []  # nothing until first get

    first = await cache.get("m")
    assert loads == ["m"]
    second = await cache.get("m")
    assert second is first
    assert loads == ["m"]  # served from cache, not reloaded


async def test_concurrent_first_use_loads_once_single_flight() -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    loads: list[str] = []

    async def factory(model_id: str) -> object:
        loads.append(model_id)
        started.set()
        await release.wait()
        return object()

    cache: ModelCache[object] = ModelCache(factory=factory)
    t1 = asyncio.create_task(cache.get("m"))
    t2 = asyncio.create_task(cache.get("m"))
    await started.wait()
    release.set()
    r1, r2 = await asyncio.gather(t1, t2)

    assert loads == ["m"]  # single-flight: only one load
    assert r1 is r2


async def test_idle_entry_is_evicted_and_reloaded_after_ttl() -> None:
    clock = _Clock()
    loads: list[str] = []
    evicted: list[str] = []

    class _Model:
        def shutdown(self) -> None:
            evicted.append("x")

    async def factory(model_id: str) -> _Model:
        loads.append(model_id)
        return _Model()

    cache: ModelCache[_Model] = ModelCache(factory=factory, ttl_seconds=60, time_func=clock)
    a = await cache.get("m")

    clock.t = 30.0
    assert await cache.get("m") is a  # within TTL → same instance
    assert loads == ["m"]

    clock.t = 121.0  # idle > 60s
    b = await cache.get("m")
    assert loads == ["m", "m"]  # evicted + reloaded on the fly
    assert b is not a
    assert evicted == ["x"]  # the idle instance was shut down


async def test_pin_prevents_idle_eviction_until_released() -> None:
    clock = _Clock()
    loads: list[str] = []

    async def factory(model_id: str) -> object:
        loads.append(model_id)
        return object()

    cache: ModelCache[object] = ModelCache(factory=factory, ttl_seconds=60, time_func=clock)
    await cache.pin("m")
    await cache.get("m")

    clock.t = 10_000.0  # far past the TTL
    await cache.get("m")
    assert loads == ["m"]  # pinned → never evicted

    await cache.unpin("m")  # idle clock restarts now
    clock.t = 10_000.0 + 61.0
    await cache.get("m")
    assert loads == ["m", "m"]  # evictable again after the last pin drops


# ── GLiNER: boot holds nothing; first analyze lazily loads once ─────────────


async def test_lifespan_does_not_load_gliner(monkeypatch: pytest.MonkeyPatch) -> None:
    import guardrail.main as main_mod
    from guardrail.providers import gliner as gliner_mod
    from guardrail.services import job_processor as jp_mod

    load_calls: list[str] = []
    monkeypatch.setattr(
        gliner_mod.GlinerProvider,
        "load",
        lambda self: load_calls.append(self.config.model_id),
    )
    monkeypatch.setattr(
        main_mod.aioredis,
        "from_url",
        lambda *a, **k: fakeredis.aioredis.FakeRedis(decode_responses=True),
    )

    # Keep the job-processor background loop out of this test — we only assert
    # that the lifespan itself never loads GLiNER weights.
    async def _noop(self: Any) -> None:
        return None

    monkeypatch.setattr(jp_mod.JobProcessor, "start_processing", _noop)

    app = main_mod.create_app()
    app.state.settings.db.db_config_enabled = False  # no DB engine wired

    async with main_mod.lifespan(app):
        # A freshly-booted worker holds ZERO GLiNER weights.
        assert load_calls == []
        assert getattr(app.state, "gliner_provider", None) is None
        cache = getattr(app.state, "gliner_cache", None)
        assert cache is None or cache.cached_models() == []

    assert load_calls == []  # teardown never loaded anything either


async def test_first_analyze_lazily_loads_gliner_once() -> None:
    app = create_app()
    app.state.settings.db.db_config_enabled = True
    resolver = StubResolver(GLINER_MODEL_ID)
    app.state.tenant_config_resolver = resolver

    loads: list[str] = []

    async def factory(model_id: str) -> FakeGliner:
        loads.append(model_id)
        return FakeGliner(model_id)

    cache: ModelCache[FakeGliner] = ModelCache(factory=factory, ttl_seconds=60, max_size=2)
    app.state.gliner_cache = cache

    assert cache.cached_models() == []  # boot: nothing loaded

    r1 = await _post(app, "/api/guardrail/analyze", {"text": "hello"})
    assert r1.status_code == 200
    assert loads == [GLINER_MODEL_ID]  # first request triggered the lazy load
    assert cache.cached_models() == [GLINER_MODEL_ID]

    r2 = await _post(app, "/api/guardrail/analyze", {"text": "again"})
    assert r2.status_code == 200
    assert loads == [GLINER_MODEL_ID]  # second request reused the cached instance


async def test_analyze_fails_closed_503_when_db_selection_missing() -> None:
    app = create_app()
    app.state.settings.db.db_config_enabled = True
    app.state.tenant_config_resolver = StubResolver(None)  # no guardrail.safety row

    resp = await _post(app, "/api/guardrail/analyze", {"text": "hello"})
    assert resp.status_code == 503


async def test_analyze_fails_closed_503_when_resolver_not_wired() -> None:
    app = create_app()
    app.state.settings.db.db_config_enabled = True
    # tenant_config_resolver never set (e.g. DB unreachable at boot).

    resp = await _post(app, "/api/guardrail/analyze", {"text": "hello"})
    assert resp.status_code == 503


# ── Groundedness (MiniCheck): DB selection + fail-closed 503 ────────────────


async def test_ground_resolves_minicheck_model_id_from_db() -> None:
    app = create_app()
    app.state.settings.service_token = SecretStr("")
    app.state.settings.groundedness = GroundednessConfig(enabled=True)
    app.state.settings.db.db_config_enabled = True
    resolver = StubResolver(MINICHECK_MODEL_ID)
    app.state.tenant_config_resolver = resolver

    async def factory(model_id: str) -> KeywordOverlapScorer:
        return KeywordOverlapScorer()

    app.state.groundedness_scorer_cache = ModelCache(factory=factory, ttl_seconds=60, max_size=2)

    resp = await _post(
        app, "/api/guardrail/ground", {"summary": SUPPORTED_CLAIM, "transcript": TRANSCRIPT}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["checked"] is True
    assert body["reason"] == "checked"
    # The reported model id is the DB-resolved sourceUri, not an env default.
    assert body["model_id"] == MINICHECK_MODEL_ID
    assert ("guardrail.groundedness") in {task for _, task in resolver.seen}


async def test_ground_fails_closed_503_when_db_selection_missing() -> None:
    app = create_app()
    app.state.settings.service_token = SecretStr("")
    app.state.settings.groundedness = GroundednessConfig(enabled=True)
    app.state.settings.db.db_config_enabled = True
    app.state.tenant_config_resolver = StubResolver(None)  # no guardrail.groundedness row

    resp = await _post(
        app, "/api/guardrail/ground", {"summary": SUPPORTED_CLAIM, "transcript": TRANSCRIPT}
    )
    assert resp.status_code == 503
