"""Smoke tests for NLP service health endpoints."""

API_PREFIX = "/api/v1"


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


def test_readiness_with_loaded_models(client):
    resp = client.get(f"{API_PREFIX}/health/ready")
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"
