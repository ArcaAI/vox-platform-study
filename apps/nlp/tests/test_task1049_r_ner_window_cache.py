"""TASK-1049 F10 — NER windows at `nlp.ner.windowChars`, and caches per tenant.

(a) `nlp.ner.windowChars` (2,000) used to bite only above `maxInputChars`
    (8,192): every text in between went through GLiNER2 as ONE pass, so the
    configured window was a number the common case never saw. A text is now
    windowed as soon as it is longer than one window.

(b) A bounded, idle-TTL NER result cache, keyed by
    ``(tenant, model weights, request parameters, sha256(window text))``. The
    tenant is IN the key (rule 09 §Config caches): two tenants that send the
    same text never share an entry, and a request with no tenant is never
    cached at all.

Fakes only — no model is ever loaded.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest

TENANT_A = "11111111-1111-1111-1111-111111111111"
TENANT_B = "22222222-2222-2222-2222-222222222222"
MODEL = "some/gliner2-model"
TERMS = {"FEVR": "symptom", "ASPN": "drug"}


class WindowRuntime:
    """Stands in for the loaded gliner2 runtime; records every text it ran on."""

    def __init__(self) -> None:
        self.texts: list[str] = []

    async def extract_entities(
        self, text: str, labels: list[str], threshold: float
    ) -> list[dict[str, Any]]:
        self.texts.append(text)
        spans = []
        for term, label in TERMS.items():
            pos = text.find(term)
            while pos != -1:
                spans.append(
                    {
                        "label": label,
                        "start": pos,
                        "end": pos + len(term),
                        "score": 0.9,
                        "text": term,
                    }
                )
                pos = text.find(term, pos + 1)
        return spans


@pytest.fixture(autouse=True)
def _fresh_state():
    from nlp.core import bounds
    from nlp.services import ner_result_cache

    bounds.reset_bounds()
    ner_result_cache.reset_ner_result_cache()
    yield
    bounds.reset_bounds()
    ner_result_cache.reset_ner_result_cache()


@pytest.fixture()
def runtime(monkeypatch) -> WindowRuntime:
    import nlp.api.v1.rest.classify as classify
    from nlp.services.gliner_token_classifier import Gliner2TokenClassifier

    runtime = WindowRuntime()
    service = Gliner2TokenClassifier(model_name=MODEL, runtime=runtime)
    service.is_initialized = True

    @asynccontextmanager
    async def pinned(*_a: Any, **_k: Any):
        yield service

    monkeypatch.setattr(classify, "pinned_token_classifier", pinned)
    return runtime


def _post(client, text: str, tenant: str | None = TENANT_A, **extra: Any):
    body = {"text": text, "model_name": MODEL, "labels": ["symptom", "drug"], **extra}
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    return client.post("/api/v1/classify/tokens", json=body, headers=headers)


def _text(n: int) -> str:
    """``n`` chars of ``abcd `` with a FEVR near the start and an ASPN near the end."""
    chars = list(("abcd " * (n // 5 + 1))[:n])
    chars[100:104] = list("FEVR")
    chars[n - 10 : n - 6] = list("ASPN")
    return "".join(chars)


# ── (a) windowing starts above the window, not above maxInputChars ───────


def test_a_text_longer_than_one_window_is_windowed_below_max_input_chars(client, runtime):
    from nlp.services.ner_windowing import plan_ner_windows

    text = _text(5000)  # > windowChars 2,000, < maxInputChars 8,192
    response = _post(client, text)

    assert response.status_code == 200
    expected = plan_ner_windows(text, 2000, 256)
    assert len(expected) == 3
    assert runtime.texts == [text[s:e] for s, e in expected]
    spans = [(e["entity_type"], e["position"]["start"]) for e in response.json()["entities"]]
    assert spans == [("symptom", 100), ("drug", 4990)]


def test_a_text_of_exactly_one_window_is_one_pass(client, runtime):
    text = _text(2000)
    assert _post(client, text).status_code == 200
    assert runtime.texts == [text]


def test_the_window_follows_the_control_plane(client, runtime):
    from nlp.core import bounds

    bounds.set_bounds(ner_window_chars=4000)
    text = _text(3000)
    assert _post(client, text).status_code == 200
    assert runtime.texts == [text]


# ── (b) the result cache ─────────────────────────────────────────────────


def test_the_same_tenant_and_text_runs_the_model_once(client, runtime):
    text = _text(800)
    first = _post(client, text).json()
    second = _post(client, text).json()

    assert runtime.texts == [text]
    assert second["entities"] == first["entities"]
    assert second["model_version"] == first["model_version"]
    # a hit ran no inference: it must not be metered as if it had (TASK-959)
    assert second["inference_ms"] == 0


def test_two_tenants_with_the_same_text_never_share_an_entry(client, runtime):
    text = _text(800)
    _post(client, text, tenant=TENANT_A)
    _post(client, text, tenant=TENANT_B)
    assert runtime.texts == [text, text]


def test_a_request_without_a_tenant_is_never_cached(client, runtime):
    text = _text(800)
    _post(client, text, tenant=None)
    _post(client, text, tenant=None)
    assert runtime.texts == [text, text]


def test_different_request_parameters_are_different_entries(client, runtime):
    text = _text(800)
    _post(client, text)
    _post(client, text, labels=["symptom"])
    _post(client, text, threshold=0.7)
    _post(client, text, model_path="/staged/other")
    assert len(runtime.texts) == 4


def test_windows_hit_individually_as_a_transcript_grows(client, runtime):
    """Windows are planned from the start, so a grown text re-runs only its tail."""
    from nlp.services.ner_windowing import plan_ner_windows

    short = _text(5000)
    grown = short + " more words appended " * 100
    _post(client, short)
    runtime.texts.clear()
    _post(client, grown)

    old = {short[s:e] for s, e in plan_ner_windows(short, 2000, 256)}
    new = [grown[s:e] for s, e in plan_ner_windows(grown, 2000, 256)]
    assert runtime.texts == [w for w in new if w not in old]
    assert len(runtime.texts) < len(new)


def test_entries_expire_after_the_ttl(client, runtime, monkeypatch):
    from nlp.core import bounds
    from nlp.services import ner_result_cache

    now = [1000.0]
    monkeypatch.setattr(ner_result_cache, "_clock", lambda: now[0])
    bounds.set_bounds(ner_result_cache_ttl_seconds=60)
    text = _text(800)

    _post(client, text)
    now[0] += 59
    _post(client, text)
    assert len(runtime.texts) == 1
    now[0] += 2
    _post(client, text)
    assert len(runtime.texts) == 2


def test_the_cache_is_bounded_least_recently_used_first(client, runtime):
    from nlp.core import bounds

    bounds.set_bounds(ner_result_cache_max_entries=2)
    a, b, c = _text(600), _text(700), _text(800)
    _post(client, a)
    _post(client, b)
    _post(client, a)  # a is now the most recent
    _post(client, c)  # evicts b
    _post(client, a)
    _post(client, b)
    assert runtime.texts == [a, b, c, b]


def test_a_zero_size_disables_the_cache(client, runtime):
    from nlp.core import bounds

    bounds.set_bounds(ner_result_cache_max_entries=0)
    text = _text(800)
    _post(client, text)
    _post(client, text)
    assert runtime.texts == [text, text]


def test_cache_bounds_follow_the_control_plane_snapshot():
    from nlp.core import bounds

    class Snapshot:
        def setting(self, key: str) -> Any:
            return {
                "nlp.ner.resultCacheTtlSeconds": 120,
                "nlp.ner.resultCacheMaxEntries": 0,
            }.get(key)

    b = bounds.apply_snapshot(Snapshot())  # type: ignore[arg-type]
    assert (b.ner_result_cache_ttl_seconds, b.ner_result_cache_max_entries) == (120, 0)


def test_the_key_names_the_tenant_and_never_the_raw_text():
    from nlp.schemas.classification import TokenClassificationRequest
    from nlp.services.ner_result_cache import ner_cache_key

    request = TokenClassificationRequest(
        text="Jane Roe has FEVR", model_name=MODEL, labels=["symptom"]
    )
    key_a = ner_cache_key(TENANT_A, request)
    key_b = ner_cache_key(TENANT_B, request)
    assert key_a is not None and key_b is not None
    assert key_a != key_b
    assert TENANT_A in key_a
    assert "Jane Roe" not in repr(key_a)
    assert ner_cache_key(None, request) is None
    assert ner_cache_key("  ", request) is None
