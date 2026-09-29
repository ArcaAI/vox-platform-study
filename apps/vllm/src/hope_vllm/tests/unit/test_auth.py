"""X-Service-Token (or Bearer): constant-time, dev bypass only when local, probes exempt."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from hope_vllm.core.config import Settings
from hope_vllm.main import create_app
from hope_vllm.tests.conftest import TENANT_ID, transcription_form
from hope_vllm.tests.fakes import FakeEngineFactory, FakeSpecResolver

HEADERS = {"X-Tenant-Id": TENANT_ID}


async def _post(app, headers: dict[str, str]) -> int:  # type: ignore[no-untyped-def]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        data, files = transcription_form()
        response = await client.post(
            "/v1/audio/transcriptions", data=data, files=files, headers=headers
        )
        return response.status_code


@pytest.fixture
def secured_app(monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "secret-token")
    return create_app(
        Settings(), engine_factory=FakeEngineFactory(), serving_spec_client=FakeSpecResolver()
    )


async def test_missing_token_is_401(secured_app) -> None:  # type: ignore[no-untyped-def]
    assert await _post(secured_app, HEADERS) == 401


async def test_wrong_token_is_401(secured_app) -> None:  # type: ignore[no-untyped-def]
    assert await _post(secured_app, {**HEADERS, "X-Service-Token": "nope"}) == 401


async def test_correct_token_passes(secured_app) -> None:  # type: ignore[no-untyped-def]
    assert await _post(secured_app, {**HEADERS, "X-Service-Token": "secret-token"}) == 200


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/health",
        "/api/v1/health/live",
        "/api/v1/health/ready",
        "/api/v1/health/startup",
        "/metrics",
    ],
)
async def test_probes_and_metrics_are_exempt(secured_app, path: str) -> None:  # type: ignore[no-untyped-def]
    async with secured_app.router.lifespan_context(secured_app):
        async with AsyncClient(
            transport=ASGITransport(app=secured_app), base_url="http://test"
        ) as client:
            assert (await client.get(path)).status_code != 401


async def test_no_token_in_local_dev_bypasses_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("INTERNAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
    monkeypatch.setenv("NODE_ENV", "development")
    app = create_app(
        Settings(), engine_factory=FakeEngineFactory(), serving_spec_client=FakeSpecResolver()
    )
    assert await _post(app, HEADERS) == 200


async def test_no_token_in_a_deployed_environment_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("INTERNAL_ACCESS_TOKEN", raising=False)
    monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "production")
    app = create_app(
        Settings(), engine_factory=FakeEngineFactory(), serving_spec_client=FakeSpecResolver()
    )
    assert await _post(app, HEADERS) == 401
