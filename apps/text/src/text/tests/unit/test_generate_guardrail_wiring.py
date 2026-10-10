"""The /generate gate invokes the external guardrail.

Verifies the guardrail is called per generate, the consultation X-Tenant-Id is
forwarded, and the posture: a content rejection is a 422 and a missing
``allowed`` key fails closed, while allowed content proceeds. A sustained screen
OUTAGE on a local provider does not fail the call (TASK-1050 §9.8.1, OD-23): it
continues with a ``guardrail.unverified`` notice.

TASK-1059 (OD-2/OD-5): the gate has no runtime MEDICAL judge any more — these tests
drive the inbound SCREEN, whose own ``medical_validation`` check (an enabled inbound
judge lane) is still what a ``CONTENT_BLOCKED_NOT_MEDICAL`` comes from. The output
screen is stubbed to allow. The guardrail client is mocked — no network.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

_ALLOW = {"allowed": True, "reason": "screened", "pii_spans": []}


def _medical_block(reason: str = "medical_validation") -> dict[str, Any]:
    return {
        "allowed": False,
        "decision": "block",
        "reason": reason,
        "pii_spans": [],
        "raw": {
            "reasons": ["medical_validation"],
            "checks": [{"name": "medical_validation", "actionTaken": "block"}],
        },
    }


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


def _make_app(registry, task_manager, guardrail_client, screen):
    from text.main import create_app

    app = create_app()
    app.state.provider_registry = registry
    app.state.task_manager = task_manager
    if guardrail_client is not None:
        guardrail_client.screen_inbound = AsyncMock(return_value=screen)
        guardrail_client.screen_output = AsyncMock(return_value={"allowed": True})
        guardrail_client.validate = AsyncMock(return_value={"allowed": True})
    app.state.guardrail_client = guardrail_client
    return app


@pytest_asyncio.fixture
async def _client_factory(mock_registry, mock_task_manager):
    clients = []

    async def _build(guardrail_client, screen=None):
        app = _make_app(
            mock_registry, mock_task_manager, guardrail_client, _ALLOW if screen is None else screen
        )
        transport = ASGITransport(app=app)
        c = AsyncClient(transport=transport, base_url="http://test")
        clients.append(c)
        return c

    yield _build
    for c in clients:
        await c.aclose()


@pytest.mark.asyncio
async def test_a_medical_scope_block_from_the_screen_is_422_not_medical(
    _client_factory, mock_provider
):
    guardrail = AsyncMock()
    client = await _client_factory(guardrail, _medical_block())

    resp = await client.post("/api/v1/generate", json={"provider": "lm-studio", "prompt": "hello"})

    assert resp.status_code == 422
    body = resp.json()
    assert "guardrail" in body["detail"].lower()
    assert body["error_code"] == "CONTENT_BLOCKED_NOT_MEDICAL"
    mock_provider.generate.assert_not_called()  # rejected before provider work


@pytest.mark.asyncio
async def test_allowed_content_proceeds(_client_factory, mock_provider):
    guardrail = AsyncMock()
    client = await _client_factory(guardrail)

    resp = await client.post(
        "/api/v1/generate",
        json={"provider": "lm-studio", "prompt": "patient note", "model": "test-model"},
    )

    assert resp.status_code == 200
    mock_provider.generate.assert_called_once()


@pytest.mark.asyncio
async def test_tenant_id_reaches_the_screen_and_no_medical_judge_runs(_client_factory):
    guardrail = AsyncMock()
    client = await _client_factory(guardrail)

    await client.post(
        "/api/v1/generate",
        json={"provider": "lm-studio", "prompt": "patient note", "system_prompt": "be careful"},
        headers={"X-Tenant-Id": "tenant-42"},
    )

    guardrail.screen_inbound.assert_awaited_once()
    assert guardrail.screen_inbound.await_args.kwargs["tenant_id"] == "tenant-42"
    guardrail.validate.assert_not_awaited()


@pytest.mark.asyncio
async def test_no_guardrail_client_skips_validation(_client_factory, mock_provider):
    client = await _client_factory(None)  # guardrail unwired

    resp = await client.post(
        "/api/v1/generate", json={"provider": "lm-studio", "prompt": "hello", "model": "test-model"}
    )

    assert resp.status_code == 200
    mock_provider.generate.assert_called_once()


# --- Degrade on an outage, fail closed on a judged rejection -----------


@pytest.mark.asyncio
async def test_sustained_screen_outage_on_a_local_provider_degrades_and_generates(
    _client_factory, mock_provider
):
    # TASK-1050 §9.8.1 / OD-23: nothing was judged, so the call continues and the response
    # carries a `guardrail.unverified` notice naming the checks that could not run.
    guardrail = AsyncMock()
    client = await _client_factory(
        guardrail, {"allowed": False, "reason": "external_guardrail_unavailable"}
    )

    resp = await client.post(
        "/api/v1/generate", json={"provider": "lm-studio", "prompt": "patient note", "model": "m"}
    )

    assert resp.status_code == 200, resp.text
    mock_provider.generate.assert_called_once()
    (notice,) = resp.json()["guardrail_notices"]
    assert notice["type"] == "guardrail.unverified"


@pytest.mark.asyncio
async def test_missing_allowed_key_fails_closed(_client_factory, mock_provider):
    # A malformed verdict with no ``allowed`` key must default to fail-CLOSED
    # (reject), never proceed — the generic content-blocked branch.
    guardrail = AsyncMock()
    client = await _client_factory(guardrail, {"reason": "malformed"})

    resp = await client.post(
        "/api/v1/generate", json={"provider": "lm-studio", "prompt": "patient note", "model": "m"}
    )

    assert resp.status_code == 422
    assert resp.json()["error_code"] == "CONTENT_BLOCKED"
    mock_provider.generate.assert_not_called()


@pytest.mark.asyncio
async def test_generic_content_block_when_not_specifically_non_medical(
    _client_factory, mock_provider
):
    # A block on a check unrelated to medical relevance gets the generic
    # `CONTENT_BLOCKED` code, never the `_NOT_MEDICAL` variant.
    guardrail = AsyncMock()
    client = await _client_factory(
        guardrail,
        {
            "allowed": False,
            "decision": "block",
            "reason": "jailbreak_detection",
            "pii_spans": [],
            "raw": {"reasons": ["jailbreak_detection"]},
        },
    )

    resp = await client.post("/api/v1/generate", json={"provider": "lm-studio", "prompt": "hello"})

    assert resp.status_code == 422
    assert resp.json()["error_code"] == "CONTENT_BLOCKED"
    mock_provider.generate.assert_not_called()


@pytest.mark.asyncio
async def test_content_rejection_never_leaks_the_free_text_reasoning(
    _client_factory, mock_provider
):
    # The REAL bug (TASK-969): a verdict's free text can quote the prompt back
    # verbatim. The response `detail` must be a FIXED sentence — the PHI-shaped
    # reason must never appear anywhere in the HTTP response body.
    phi_shaped_reason = "the prompt discusses patient Jane Doe, DOB 1990-01-01, SSN 123-45-6789"
    guardrail = AsyncMock()
    client = await _client_factory(guardrail, _medical_block(phi_shaped_reason))

    resp = await client.post("/api/v1/generate", json={"provider": "lm-studio", "prompt": "hello"})

    assert resp.status_code == 422
    assert resp.json()["error_code"] == "CONTENT_BLOCKED_NOT_MEDICAL"
    assert "123-45-6789" not in resp.text
    assert "Jane Doe" not in resp.text
    mock_provider.generate.assert_not_called()
