"""TDD tests for the NLP ServiceAuthMiddleware (TASK-465).

Verifies inter-service authentication via the ``X-Service-Token`` header:
an empty ``service_token`` bypasses auth entirely (dev mode / hermetic CI),
and a configured token is enforced on every non-exempt path.

The middleware reads the token from the module-singleton config at dispatch
time, so tests monkeypatch ``nlp.core.config.settings.service`` before issuing
the request.

RED: written before the middleware and the ``service_token`` config field exist.
"""

from __future__ import annotations

import pytest
from pydantic import SecretStr

from nlp.core.config import settings as nlp_settings

# A route that does not exist under the versioned prefix. When auth passes the
# request falls through to a 404 (route miss); when auth fails the middleware
# returns 401 first. This isolates the middleware from real endpoint handlers
# and their model dependencies.
PROBE_PATH = "/api/v1/__auth_probe__"
PROTECTED_TOKEN = "test-service-token-nlp-abc123"  # noqa: S105 — test constant, not a real secret

EXEMPT_LIVE_PATHS = [
    "/",
    "/api/v1/health",
    "/api/v1/health/live",
    "/api/v1/health/ready",
    "/docs",
    "/openapi.json",
]


def _set_token(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    """Point the module-singleton config at ``value``; middleware reads it at dispatch."""
    monkeypatch.setattr(nlp_settings.service, "service_token", SecretStr(value), raising=False)


# ── Auth disabled (dev mode) ──


def test_empty_token_bypasses_auth(client, monkeypatch):
    """Empty service_token => auth fully bypassed (protected path is not 401)."""
    _set_token(monkeypatch, "")
    resp = client.get(PROBE_PATH)
    assert resp.status_code != 401
    assert resp.status_code == 404


# ── Auth enabled ──


def test_missing_token_rejected(client, monkeypatch):
    """A configured token with no header on a protected path => 401."""
    _set_token(monkeypatch, PROTECTED_TOKEN)
    resp = client.get(PROBE_PATH)
    assert resp.status_code == 401


def test_wrong_token_rejected(client, monkeypatch):
    """A configured token with the wrong header value => 401."""
    _set_token(monkeypatch, PROTECTED_TOKEN)
    resp = client.get(PROBE_PATH, headers={"X-Service-Token": "wrong-token"})
    assert resp.status_code == 401


def test_correct_token_passes(client, monkeypatch):
    """The correct token passes the middleware; the probe route still 404s."""
    _set_token(monkeypatch, PROTECTED_TOKEN)
    resp = client.get(PROBE_PATH, headers={"X-Service-Token": PROTECTED_TOKEN})
    assert resp.status_code != 401
    assert resp.status_code == 404


def test_rejection_body(client, monkeypatch):
    """The 401 body matches the contract the gateway expects."""
    _set_token(monkeypatch, PROTECTED_TOKEN)
    resp = client.get(PROBE_PATH)
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Invalid or missing service token"}


# ── Exempt paths (reachable without a token even when auth is on) ──


@pytest.mark.parametrize("path", EXEMPT_LIVE_PATHS)
def test_exempt_paths_reachable_without_token(client, monkeypatch, path):
    """Health / docs / root are reachable without a token even when auth is on."""
    _set_token(monkeypatch, PROTECTED_TOKEN)
    resp = client.get(path)
    assert resp.status_code != 401


def test_exempt_paths_membership():
    """EXEMPT_PATHS covers the NLP health surface, metrics, docs, and root."""
    from nlp.api.middleware.auth import EXEMPT_PATHS

    for path in (
        "/",
        "/api/v1/health",
        "/api/v1/health/live",
        "/api/v1/health/ready",
        "/metrics",
        "/docs",
        "/redoc",
        "/openapi.json",
    ):
        assert path in EXEMPT_PATHS
