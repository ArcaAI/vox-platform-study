"""The /generate gate invokes the external guardrail.

Verifies the guardrail is called per generate, the consultation X-Tenant-Id is
forwarded, and the degrade-safe → fail-CLOSED posture: a content
rejection is a 422, a sustained outage is a retryable 503, a missing ``allowed``
key fails closed, and an unwired client under the enforce posture fails closed —
while allowed content proceeds and the dev bypass (disabled/unwired) is preserved.
The guardrail client is mocked — no network.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def mock_provider():
    provider = AsyncMock()
    provider.generate = AsyncMock(
        return_value=("ok", "", {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})
    )
    return provider


@pytest.fixture
def mock_registry(mock_provider):
    registry = MagicMock()
    registry.get.return_value = mock_provider
    return registry


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    task_state = MagicMock()
    task_state.task_id = "task-1"
    tm.create_task = AsyncMock(return_value=task_state)
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    return tm


def _make_app(registry, task_manager, guardrail_client):
    from text.main import create_app

    app = create_app()
    app.state.provider_registry = registry
    app.state.task_manager = task_manager
    app.state.guardrail_client = guardrail_client
    return app


@pytest_asyncio.fixture
async def _client_factory(mock_registry, mock_task_manager):
    clients = []

    async def _build(guardrail_client):
        app = _make_app(mock_registry, mock_task_manager, guardrail_client)
        transport = ASGITransport(app=app)
        c = AsyncClient(transport=transport, base_url="http://test")
        clients.append(c)
        return c

    yield _build
    for c in clients:
        await c.aclose()


@pytest.mark.asyncio
async def test_blocked_content_rejected_with_422(_client_factory, mock_provider):
    # A genuine content rejection (guardrail reachable, verdict not-allowed) is a 422.
    # `is_medical: False` is the REAL shape `ExternalGuardrailClient.validate()._parse`
    # always sets on a reachable rejection (TASK-969 WS-3) — it is the signal the
    # gate uses to pick `CONTENT_BLOCKED_NOT_MEDICAL`, never the free-text `reason`.
    guardrail = AsyncMock()
    guardrail.validate = AsyncMock(
        return_value={"allowed": False, "reason": "not_medical", "is_medical": False}
    )
    client = await _client_factory(guardrail)

    resp = await client.post("/api/v1/generate", json={"prompt": "hello"})

    assert resp.status_code == 422
    body = resp.json()
    assert "guardrail" in body["detail"].lower()
    assert body["error_code"] == "CONTENT_BLOCKED_NOT_MEDICAL"
    mock_provider.generate.assert_not_called()  # rejected before provider work


@pytest.mark.asyncio
async def test_allowed_content_proceeds(_client_factory, mock_provider):
    guardrail = AsyncMock()
    guardrail.validate = AsyncMock(return_value={"allowed": True})
    client = await _client_factory(guardrail)

    resp = await client.post(
        "/api/v1/generate", json={"prompt": "patient note", "model": "test-model"}
    )

    assert resp.status_code == 200
    mock_provider.generate.assert_called_once()


@pytest.mark.asyncio
async def test_tenant_id_header_propagated_to_guardrail(_client_factory):
    guardrail = AsyncMock()
    guardrail.validate = AsyncMock(return_value={"allowed": True})
    client = await _client_factory(guardrail)

    await client.post(
        "/api/v1/generate",
        json={"prompt": "patient note", "system_prompt": "be careful"},
        headers={"X-Tenant-Id": "tenant-42"},
    )

    guardrail.validate.assert_awaited_once()
    kwargs = guardrail.validate.await_args.kwargs
    assert kwargs["tenant_id"] == "tenant-42"
    assert kwargs["prompt"] == "patient note"
    assert kwargs["system_prompt"] == "be careful"


@pytest.mark.asyncio
async def test_no_guardrail_client_skips_validation(_client_factory, mock_provider):
    client = await _client_factory(None)  # guardrail unwired

    resp = await client.post("/api/v1/generate", json={"prompt": "hello", "model": "test-model"})

    assert resp.status_code == 200
    mock_provider.generate.assert_called_once()


# --- Degrade-safe → fail-CLOSED gate -----------------------------------


@pytest.mark.asyncio
async def test_sustained_outage_returns_503_and_never_generates(_client_factory, mock_provider):
    # A sustained guardrail outage (unavailable verdict) is a RETRYABLE 503
    # (distinct from a 422 content rejection) and generation never runs.
    guardrail = AsyncMock()
    guardrail.validate = AsyncMock(
        return_value={"allowed": False, "reason": "external_guardrail_unavailable"}
    )
    client = await _client_factory(guardrail)

    resp = await client.post("/api/v1/generate", json={"prompt": "patient note", "model": "m"})

    assert resp.status_code == 503
    assert resp.json()["error_code"] == "GUARDRAIL_UNAVAILABLE"
    mock_provider.generate.assert_not_called()


@pytest.mark.asyncio
async def test_missing_allowed_key_fails_closed(_client_factory, mock_provider):
    # A malformed verdict with no ``allowed`` key must default to fail-CLOSED
    # (reject), never proceed. No ``is_medical`` key either, so this is the
    # generic (not-specifically-non-medical) content-blocked branch.
    guardrail = AsyncMock()
    guardrail.validate = AsyncMock(return_value={"reason": "malformed"})
    client = await _client_factory(guardrail)

    resp = await client.post("/api/v1/generate", json={"prompt": "patient note", "model": "m"})

    assert resp.status_code == 422
    assert resp.json()["error_code"] == "CONTENT_BLOCKED"
    mock_provider.generate.assert_not_called()


@pytest.mark.asyncio
async def test_generic_content_block_when_not_specifically_non_medical(
    _client_factory, mock_provider
):
    # A reachable, blocked verdict that does NOT say `is_medical: False` (e.g. a
    # future guardrail check unrelated to medical relevance) gets the generic
    # `CONTENT_BLOCKED` code, never the `_NOT_MEDICAL` variant.
    guardrail = AsyncMock()
    guardrail.validate = AsyncMock(
        return_value={"allowed": False, "reason": "some_other_policy", "is_medical": True}
    )
    client = await _client_factory(guardrail)

    resp = await client.post("/api/v1/generate", json={"prompt": "hello"})

    assert resp.status_code == 422
    assert resp.json()["error_code"] == "CONTENT_BLOCKED"
    mock_provider.generate.assert_not_called()


@pytest.mark.asyncio
async def test_content_rejection_never_leaks_the_free_text_reasoning(
    _client_factory, mock_provider
):
    # The REAL bug (TASK-969): `reason` here mirrors guardrail's `reasoning`
    # field, which can quote the prompt back verbatim. The response `detail`
    # must be a FIXED sentence — the PHI-shaped reason must never appear
    # anywhere in the HTTP response body.
    phi_shaped_reason = "the prompt discusses patient Jane Doe, DOB 1990-01-01, SSN 123-45-6789"
    guardrail = AsyncMock()
    guardrail.validate = AsyncMock(
        return_value={"allowed": False, "reason": phi_shaped_reason, "is_medical": False}
    )
    client = await _client_factory(guardrail)

    resp = await client.post("/api/v1/generate", json={"prompt": "hello"})

    assert resp.status_code == 422
    assert resp.json()["error_code"] == "CONTENT_BLOCKED_NOT_MEDICAL"
    assert "123-45-6789" not in resp.text
    assert "Jane Doe" not in resp.text
    mock_provider.generate.assert_not_called()


@pytest.mark.asyncio
async def test_none_client_with_enforce_posture_fails_closed(
    mock_registry, mock_task_manager, mock_provider
):
    # Moderation ON but the client is unwired → fail CLOSED (503), not a silent
    # skip that ships unmoderated PHI. The posture comes from the control plane,
    # so it is read off live state rather than off settings.
    from text.core.guardrail_posture import GuardrailPosture

    app = _make_app(mock_registry, mock_task_manager, None)
    app.state.guardrail_posture = GuardrailPosture(enabled=True)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/api/v1/generate", json={"prompt": "patient note", "model": "m"})

    assert resp.status_code == 503
    assert resp.json()["error_code"] == "GUARDRAIL_UNAVAILABLE"
    mock_provider.generate.assert_not_called()
