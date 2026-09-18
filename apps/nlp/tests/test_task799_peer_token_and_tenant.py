"""lane C.3 (F-06) and C.4 (F-10).

C.3 — `lifespan.py` read `settings.service.service_token` directly at two of its
three outbound call sites instead of going through `peer_service_token()`. Under
owner decision D-D (one shared `INTERNAL_ACCESS_TOKEN`, legacy per-service token
empty) both sites therefore sent an EMPTY token and 401'd: the effective-config
pull silently degraded to env values, and self-registration never landed.

C.4 — the tenant-scoped routes read `tenant_id` from the request BODY and nothing
read the inbound `X-Tenant-Id` header, so a caller sending header `A` with body
`B` was accepted and the attributable record followed `B`. Guardrail's client
sends BOTH, so they must agree.
"""

from __future__ import annotations

import pytest
from pydantic import SecretStr


class TestLifespanPresentsTheSharedToken:
    """Configure the platform the way D-D specifies and watch the header."""

    @pytest.fixture()
    def shared_token_only(self, monkeypatch: pytest.MonkeyPatch):
        from nlp.core.config import settings

        monkeypatch.setattr(
            settings.service, "internal_access_token", SecretStr("shared-internal"), raising=False
        )
        return settings

    async def test_effective_config_client_carries_the_shared_token(
        self, shared_token_only, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import nlp.lifespan as lifespan_module

        captured: dict[str, object] = {}

        class _Recorder:
            def __init__(self, **kwargs: object) -> None:
                captured.update(kwargs)

        monkeypatch.setattr(lifespan_module, "EffectiveConfigClient", _Recorder)
        await _run_lifespan(lifespan_module, monkeypatch)

        assert captured["token"] == "shared-internal"

    async def test_service_registration_carries_the_shared_token(
        self, shared_token_only, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import nlp.lifespan as lifespan_module

        captured: dict[str, object] = {}

        def _record(**kwargs: object) -> None:
            captured.update(kwargs)
            return None

        monkeypatch.setattr(lifespan_module, "start_registration", _record)
        await _run_lifespan(lifespan_module, monkeypatch)

        assert captured["service_token"] == "shared-internal"


async def _run_lifespan(lifespan_module, monkeypatch: pytest.MonkeyPatch) -> None:
    """Enter and exit `lifespan` with every side effect stubbed out."""
    from fastapi import FastAPI

    # `setup_opentelemetry` is no longer stubbed here because the lifespan no
    # longer calls it: observability moved into the app factory (TASK-987 B-1),
    # since middleware cannot be added once the lifespan is running.
    monkeypatch.setattr(lifespan_module, "shutdown_opentelemetry", lambda app: None)

    class _FakeWebSocketManager:
        async def initialize(self) -> None: ...

        async def shutdown(self) -> None: ...

    monkeypatch.setattr(lifespan_module, "get_websocket_manager", lambda: _FakeWebSocketManager())
    monkeypatch.setattr(lifespan_module, "warm_models", _noop_warm)

    app = FastAPI()
    async with lifespan_module.lifespan(app):
        pass


async def _noop_warm(*args: object, **kwargs: object) -> None:
    return None


class TestBodyTenantIsCrossCheckedAgainstTheHeader:
    """Header and body must agree, on every surface that reads a body tenant."""

    def test_guard_pii_rejects_a_mismatch(self, client) -> None:
        response = client.post(
            "/api/v1/guard/pii",
            json={
                "text": "John Doe",
                "tenant_id": "tenant-b",
                "model_name": "db/guard",
                "labels": ["person"],
            },
            headers={"X-Tenant-Id": "tenant-a"},
        )
        assert response.status_code == 400
        assert "tenant" in response.json()["error"].lower()

    def test_guard_pii_accepts_agreement(self, client) -> None:
        """Control: a matching pair must still get past the tenant guard.

        It fails later (no such model), which is the point — the tenant check is
        not what stopped it.
        """
        response = client.post(
            "/api/v1/guard/pii",
            json={
                "text": "John Doe",
                "tenant_id": "tenant-a",
                "model_name": "db/guard",
                "labels": ["person"],
            },
            headers={"X-Tenant-Id": "tenant-a"},
        )
        assert response.status_code == 503

    def test_no_header_is_still_allowed(self, client) -> None:
        """The header is the CALLER's business ( enforces it upstream).

        This check is about DISAGREEMENT, not about adding a second mandatory
        header — a body tenant with no header keeps working exactly as before.
        """
        response = client.post(
            "/api/v1/guard/pii",
            json={
                "text": "John Doe",
                "tenant_id": "tenant-a",
                "model_name": "db/guard",
                "labels": ["person"],
            },
        )
        assert response.status_code == 503

    def test_classify_topic_rejects_a_mismatch(self, client) -> None:
        response = client.post(
            "/api/v1/classify/topic",
            json={
                "text": "chest pain",
                "tenant_id": "tenant-b",
                "instructions": ["cardio", "resp"],
            },
            headers={"X-Tenant-Id": "tenant-a"},
        )
        assert response.status_code == 400
