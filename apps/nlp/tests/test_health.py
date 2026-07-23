"""Smoke tests for NLP service health endpoints."""

from types import SimpleNamespace

API_PREFIX = "/api/v1"

# The cache-backed components whose health reflects per-request ModelCache state
# (NOT the singleton getters — see BUG-010).
_CACHE_BACKED = ("text_classifier", "token_classifier", "medical_suggester")
# Every component reported by /health.
_ALL_COMPONENTS = (*_CACHE_BACKED, "text_corrector")


def test_root_returns_service_info(client):
    resp = client.get("/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["service"] == "Medical Entity Recognition & NLP"
    assert "version" in body


def test_health_returns_status(client):
    resp = client.get(f"{API_PREFIX}/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] in {"healthy", "degraded", "unhealthy"}
    assert "checks" in body
    assert "uptime_seconds" in body


def test_liveness_always_healthy(client):
    resp = client.get(f"{API_PREFIX}/health/live")
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"


# --- BUG-010: lazy-model health must not read as unhealthy ------------------


def test_health_idle_is_healthy_with_lazy_components(client):
    """A booted service with zero warmed models is healthy, not degraded.

    Regression guard for BUG-010: models load lazily through a per-request
    ModelCache, so a cold component is `lazy`, never `unhealthy`, and never
    drags `overall` below `healthy`.
    """
    body = client.get(f"{API_PREFIX}/health").json()

    assert body["status"] == "healthy"
    checks = body["checks"]
    # No component ever reads as unhealthy — lazy is the resting state.
    for name in _ALL_COMPONENTS:
        assert checks[name]["status"] == "lazy", f"{name} should be lazy at idle"
        assert isinstance(checks[name]["loaded"], bool)
    # Cache-backed components hold no resident models on a cold worker.
    for name in _CACHE_BACKED:
        assert checks[name]["loaded"] is False, f"{name} should be unloaded at idle"
        assert checks[name]["loaded_models"] == [], f"{name} has no resident models at idle"


def test_health_reports_resident_models_from_cache(client):
    """Once a cache holds a warmed model, /health surfaces it — proving the check
    observes the SAME objects that serve inference (BUG-010 root cause)."""
    import nlp.dependencies as deps

    saved = deps.__dict__.get("_text_classifier_cache_instance")
    deps.__dict__["_text_classifier_cache_instance"] = SimpleNamespace(
        cached_models=lambda: ["clinical-doc-classifier-v1"]
    )
    try:
        body = client.get(f"{API_PREFIX}/health").json()
    finally:
        deps.__dict__["_text_classifier_cache_instance"] = saved

    tc = body["checks"]["text_classifier"]
    assert tc["status"] == "lazy"
    assert tc["loaded"] is True
    assert tc["loaded_models"] == ["clinical-doc-classifier-v1"]
    assert body["status"] == "healthy"


def test_readiness_ready_without_models(client):
    """Readiness must not gate on lazy model loading — a booted process that
    lazy-loads on first request is ready (BUG-010)."""
    resp = client.get(f"{API_PREFIX}/health/ready")
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"
