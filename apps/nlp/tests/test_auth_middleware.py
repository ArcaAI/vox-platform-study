"""Tests for the NLP inter-service authentication.

Covers three surfaces:
- HTTP: ``ServiceAuthMiddleware`` — empty token bypass (dev / hermetic CI),
  missing/wrong token => 401, exempt paths reachable.
- WebSocket: ``enforce_service_token_ws`` — ``BaseHTTPMiddleware`` never sees WS
  scopes, so the ``/ws/classify`` handlers gate themselves before ``accept()``.
- Env binding: ``INTERNAL_ACCESS_TOKEN`` actually binds to the config (not just
  a monkeypatched attribute) and drives enforcement.

The auth code reads the token from the ``nlp.core.config`` module singleton at
dispatch time, so tests point ``settings.service`` at the desired token first.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import WebSocketDisconnect
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
    """Point the module-singleton config at ``value``; the auth code reads it at dispatch.

    There is exactly ONE accepted token to pin. `accepted_service_tokens` admits
    only the canonical shared `internal_access_token`; TASK-799 lane D removed
    the legacy per-service `NLP_SERVICE_TOKEN` alongside it.

    That removal is what makes this helper reliable. While both existed, pinning
    only the legacy one left whatever `INTERNAL_ACCESS_TOKEN` the loaded
    `.env.test` carried still in play — so asking for `""` ("auth disabled")
    produced a configured token and a 401 anyway.
    """
    monkeypatch.setattr(
        nlp_settings.service, "internal_access_token", SecretStr(value), raising=False
    )


# ── HTTP auth disabled (dev mode) ──


def test_empty_token_bypasses_auth(client, monkeypatch):
    """An empty shared token => auth fully bypassed (protected path is not 401)."""
    _set_token(monkeypatch, "")
    resp = client.get(PROBE_PATH)
    assert resp.status_code != 401
    assert resp.status_code == 404


# ── HTTP auth enabled ──


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


# ── HTTP exempt paths (reachable without a token even when auth is on) ──


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


# ── WebSocket enforcement ──
#
# ServiceAuthMiddleware is a BaseHTTPMiddleware whose dispatch() NEVER runs for
# websocket scopes, so the /ws/classify handlers call enforce_service_token_ws()
# before accepting. The guard is unit-tested directly against a fake WebSocket
# (empty bypass / missing / wrong / correct), and the real endpoints are
# additionally proven to reject an unauthenticated handshake.


class _FakeWS:
    """Minimal WebSocket stand-in for ``enforce_service_token_ws``."""

    def __init__(self, token_header: str | None = None) -> None:
        self.headers = {} if token_header is None else {"x-service-token": token_header}
        self.url = SimpleNamespace(path="/ws/classify/token/session-1")
        self.closed_code: int | None = None

    async def close(self, code: int = 1000) -> None:
        self.closed_code = code


async def test_ws_guard_empty_token_allows(monkeypatch):
    """Empty token => the guard allows (dev bypass) and never closes."""
    _set_token(monkeypatch, "")
    from nlp.api.middleware.auth import enforce_service_token_ws

    ws = _FakeWS()
    assert await enforce_service_token_ws(ws) is True
    assert ws.closed_code is None


async def test_ws_guard_missing_token_closes_1008(monkeypatch):
    """Token set + no header => the guard closes with policy-violation 1008 and denies."""
    _set_token(monkeypatch, PROTECTED_TOKEN)
    from nlp.api.middleware.auth import enforce_service_token_ws

    ws = _FakeWS()
    assert await enforce_service_token_ws(ws) is False
    assert ws.closed_code == 1008


async def test_ws_guard_wrong_token_closes_1008(monkeypatch):
    """Token set + wrong header => the guard closes 1008 and denies."""
    _set_token(monkeypatch, PROTECTED_TOKEN)
    from nlp.api.middleware.auth import enforce_service_token_ws

    ws = _FakeWS("wrong-token")
    assert await enforce_service_token_ws(ws) is False
    assert ws.closed_code == 1008


async def test_ws_guard_correct_token_allows(monkeypatch):
    """Token set + correct header => the guard allows and never closes."""
    _set_token(monkeypatch, PROTECTED_TOKEN)
    from nlp.api.middleware.auth import enforce_service_token_ws

    ws = _FakeWS(PROTECTED_TOKEN)
    assert await enforce_service_token_ws(ws) is True
    assert ws.closed_code is None


def test_real_ws_classify_endpoints_enforced(client, monkeypatch):
    """The real /ws/classify token+text endpoints reject an unauthenticated handshake.

    The guard runs before ``service.process`` is dereferenced, so rejection works
    with the fixture's stub dependencies.
    """
    _set_token(monkeypatch, PROTECTED_TOKEN)
    for path in ("/ws/classify/token/session-1", "/ws/classify/text/session-1"):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(path):
                pass


# ── Env binding (proves INTERNAL_ACCESS_TOKEN binds, not just monkeypatch) ──


def test_service_token_binds_from_env(client, monkeypatch):
    """The shared INTERNAL_ACCESS_TOKEN binds to the config and drives HTTP
    enforcement. It is the ONE accepted credential since TASK-799 lane D removed
    the legacy per-service `NLP_SERVICE_TOKEN`."""
    from nlp.core.config import NLPServiceConfig

    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "env-nlp-token-xyz")
    rebuilt = NLPServiceConfig()
    assert rebuilt.internal_access_token.get_secret_value() == "env-nlp-token-xyz"
    # The auth code reads the module singleton; point it at the env-bound config.
    monkeypatch.setattr(nlp_settings, "service", rebuilt)
    resp = client.get(PROBE_PATH)
    assert resp.status_code == 401
