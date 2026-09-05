"""The WebSocket handshake must authenticate EXACTLY like HTTP does.

Two properties, both of which the WS path failed before this suite existed:

1. **Same accepted-token set.** ``BaseHTTPMiddleware`` never sees a WebSocket
   scope, so ``/api/v1/audio/stream`` does its own check. That check read only
   the LEGACY ``service_token``, not ``accepted_service_tokens`` — so completing
   owner decision D-D properly (set ``INTERNAL_ACCESS_TOKEN``, delete the legacy
   var — the documented end state) made the WS read an empty string and take its
   ``if not token: return True`` branch. Doing the migration CORRECTLY is what
   opened the socket, while HTTP stayed protected.

2. **The dev bypass is a decision, not an accident.** "No token configured" is a
   deliberate local-development affordance. It must therefore be conditioned on
   actually BEING in local development: in a deployed environment an unset shared
   token is a misconfiguration, and a misconfiguration must fail CLOSED.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from starlette.websockets import WebSocketDisconnect

from tts.core.config import Settings
from tts.main import create_app
from tts.tests.fakes import FakeEngine, candidate, spec_json, voice_binding

SHARED = "shared-internal-access-token-xyz"  # noqa: S105 — test constant
LEGACY = "legacy-tts-service-token-abc"  # noqa: S105 — test constant

WS_PATH = "/api/v1/audio/stream"
NONEXEMPT_HTTP = "/api/v1/audio/speech"


@pytest.fixture(autouse=True)
def _clean_token_env(monkeypatch):
    """Never inherit a real token (or a deployed env) from the developer's shell."""
    monkeypatch.delenv("INTERNAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("TTS_SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)


def _app(*, shared: str = "", legacy: str = "", monkeypatch=None):
    """Build the app with a given credential configuration.

    `legacy` sets the RETIRED `TTS_SERVICE_TOKEN` ( lane C). It is kept
    as a parameter precisely so a test can prove the old name is now INERT —
    setting it must neither grant access nor, worse, silently disable auth.
    """
    if monkeypatch is not None:
        if shared:
            monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", shared)
        if legacy:
            monkeypatch.setenv("TTS_SERVICE_TOKEN", legacy)
    settings = Settings()
    app = create_app(settings_override=settings)
    app.state.provider_registry.register(
        "azure", FakeEngine("azure", native_streaming=False, chunks=1)
    )
    return app


def _init_frame() -> dict:
    return {
        "type": "init",
        "voice": "en-female-1",
        "format": "pcm",
        "resolved_spec": spec_json(candidate("azure", voices=[voice_binding("en-female-1", locale="en-IN")], voice="en-female-1")),
    }


def _assert_handshake_refused(client, headers: dict | None = None) -> None:
    """The socket must be closed with 4401 before it can carry any traffic.

    The init frame is sent DELIBERATELY: a rejected handshake raises on connect
    (or on the first receive), while an ACCEPTED one answers ``ready`` — so this
    fails loudly instead of blocking forever on a socket that was wrongly let in.
    """
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(WS_PATH, headers=headers or {}) as ws:
            ws.send_json(_init_frame())
            got = ws.receive_json()
            pytest.fail(f"handshake was accepted without a valid token; server replied {got!r}")
    assert exc.value.code == 4401


# ── 1. the shared token must open the socket, and its absence must close it ────


def test_ws_accepts_the_shared_internal_access_token(monkeypatch):
    """D-D end state: ONLY `INTERNAL_ACCESS_TOKEN` set, legacy var deleted."""
    app = _app(shared=SHARED, monkeypatch=monkeypatch)
    with TestClient(app) as client:
        with client.websocket_connect(WS_PATH, headers={"x-service-token": SHARED}) as ws:
            ws.send_json(_init_frame())
            assert ws.receive_json()["type"] == "ready"


def test_ws_rejects_a_missing_header_when_only_the_shared_token_is_set(monkeypatch):
    """THE defect: this connection was ACCEPTED because `service_token` was empty."""
    app = _app(shared=SHARED, monkeypatch=monkeypatch)
    with TestClient(app) as client:
        _assert_handshake_refused(client)


def test_ws_rejects_a_wrong_token_when_only_the_shared_token_is_set(monkeypatch):
    app = _app(shared=SHARED, monkeypatch=monkeypatch)
    with TestClient(app) as client:
        _assert_handshake_refused(client, headers={"x-service-token": "nope"})


def test_ws_refuses_the_retired_legacy_token(monkeypatch):
    """`TTS_SERVICE_TOKEN` is retired and must now be inert ( lane C).

    Two things are asserted at once, and the second is the one that would hurt:
    presenting the legacy token is refused, AND setting the legacy variable does
    not quietly count as "a credential is configured" — which would leave the
    service accepting the shared token only while an operator believed the old
    name still worked.
    """
    app = _app(shared=SHARED, legacy=LEGACY, monkeypatch=monkeypatch)
    with TestClient(app) as client:
        _assert_handshake_refused(client, headers={"x-service-token": LEGACY})


def test_the_retired_legacy_variable_configures_nothing_at_all(monkeypatch):
    """Set ONLY the legacy name: the service must behave as if none were set.

    It must not become half-configured — the failure mode where one credential
    is honoured on some hops and not others is exactly what retiring the second
    name removes.
    """
    monkeypatch.setenv("TTS_SERVICE_TOKEN", LEGACY)
    settings = Settings()
    assert settings.accepted_service_tokens == ()
    assert settings.peer_service_token() == ""


# ── 2. the dev bypass is conditional on actually being in local development ────


def test_ws_no_token_configured_is_a_bypass_in_local_development():
    """Unchanged, deliberate affordance: `pnpm tts:dev` with no token works."""
    app = _app()
    with TestClient(app) as client:
        with client.websocket_connect(WS_PATH) as ws:
            ws.send_json(_init_frame())
            assert ws.receive_json()["type"] == "ready"


def test_ws_no_token_configured_fails_closed_in_a_deployed_environment(monkeypatch):
    """An unset shared token in production is a misconfiguration, not an open door."""
    monkeypatch.setenv("NODE_ENV", "production")
    app = _app()
    with TestClient(app) as client:
        _assert_handshake_refused(client)


def test_ws_deployment_environment_also_marks_the_environment_as_deployed(monkeypatch):
    """`DEPLOYMENT_ENVIRONMENT` is the k8s-side spelling; both must count."""
    monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "staging")
    app = _app()
    with TestClient(app) as client:
        _assert_handshake_refused(client)


# ── 3. HTTP keeps the same semantics, so the two paths cannot drift again ──────


@pytest.mark.asyncio
async def test_http_no_token_configured_fails_closed_in_a_deployed_environment(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    transport = ASGITransport(app=_app())
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.get(NONEXEMPT_HTTP)).status_code == 401


@pytest.mark.asyncio
async def test_http_health_stays_reachable_when_failing_closed(monkeypatch):
    """A fail-closed service must still answer its k8s probes."""
    monkeypatch.setenv("NODE_ENV", "production")
    transport = ASGITransport(app=_app())
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.get("/api/v1/health")).status_code == 200


@pytest.mark.asyncio
async def test_http_accepts_the_shared_token(monkeypatch):
    transport = ASGITransport(app=_app(shared=SHARED, monkeypatch=monkeypatch))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(NONEXEMPT_HTTP, headers={"X-Service-Token": SHARED})
        assert resp.status_code != 401
