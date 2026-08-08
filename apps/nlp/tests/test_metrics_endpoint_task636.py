"""NLP ``/metrics`` endpoint contract (TASK-636 OBS-02, OBS-03).

Two defects this file locks down, both found live on 2026-08-08 against
``hope-v2-dev`` where ``GET http://hope-nlp:8864/metrics`` returned **404**
while ``/api/v1/health`` on the same port returned healthy:

OBS-02 — the endpoint was not mounted at all. ``setup_prometheus`` passed
``should_respect_env_var=True, env_var_name="ENABLE_METRICS"``, and
``ENABLE_METRICS`` is set in no environment, so the instrumentator skipped
both instrumentation and exposition. Every other Python service in the fleet
gates on its own ``metrics_enabled`` setting instead.

OBS-03 — the same call passed ``metric_namespace="nlp"``, emitting
``nlp_http_*``. The fleet-wide contract is un-namespaced ``http_*``: the dev
Prometheus ``metric_relabel_configs`` rule matches ``__name__ =~ "http_.*"``
to stamp the ``service`` label, and ``PlatformMetricsService`` queries
``sum by (service) (rate(http_requests_total[5m]))``. Namespaced series match
neither, so NLP was silently absent from the platform dashboard.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def metrics_client() -> TestClient:
    """An app built the way production builds it — with ENABLE_METRICS unset.

    Deliberately does NOT use the ``mock_services`` fixture: that fixture
    patches out ``setup_prometheus``, which is the code under test here.
    The lifespan is lazy (no eager model loading), and a non-context
    ``TestClient`` does not run it, so no ML weights are touched.

    Module-scoped on purpose. ``prometheus_client`` uses a process-global
    ``REGISTRY``, so building a second app in the same process raises
    ``DuplicateTimeseries``. One app per process is also what production does.
    """
    os.environ.pop("ENABLE_METRICS", None)

    from nlp.app import get_app

    return TestClient(get_app())


def test_metrics_endpoint_is_mounted_without_enable_metrics_env(
    metrics_client: TestClient,
) -> None:
    """OBS-02: /metrics must serve, not 404, with ENABLE_METRICS unset."""
    response = metrics_client.get("/metrics")

    assert response.status_code == 200, (
        "NLP /metrics must be mounted whenever metrics are enabled in settings. "
        "A 404 here means the instrumentator was gated on an env var that no "
        "environment sets (OBS-02)."
    )


def test_http_metrics_are_not_namespaced(metrics_client: TestClient) -> None:
    """OBS-03: series must be ``http_*``, matching the rest of the fleet."""
    # Generate at least one request so the instrumentator emits a sample.
    metrics_client.get("/api/v1/health")
    body = metrics_client.get("/metrics").text

    assert "http_request" in body, "expected un-namespaced http_* series"
    assert "nlp_http_" not in body, (
        "NLP must not namespace its HTTP metrics. The dev Prometheus relabel "
        "rule matches '^http_.*' and PlatformMetricsService queries "
        "http_requests_total — 'nlp_http_*' matches neither (OBS-03)."
    )
