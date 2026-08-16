"""ConsentClient (TASK-712, consent-abac Phase 4).

Hermetic: `httpx.MockTransport` + a fake monotonic clock. No live gateway.
"""

from __future__ import annotations

import httpx
import pytest

from harness.core.consent_client import ConsentClient, ConsentDecision


def _client(handler, *, ttl_s: int = 30, time_func=None) -> ConsentClient:  # noqa: ANN001
    return ConsentClient(
        base_url="http://gateway.test/api/v1/internal/consent",
        token="harness-token",
        ttl_s=ttl_s,
        transport=httpx.MockTransport(handler),
        time_func=time_func,
    )


@pytest.mark.asyncio
async def test_allowed_decision_round_trips() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/assert")
        return httpx.Response(
            200,
            json={"allowed": True, "grantId": "grant-1", "expiresAt": "2027-01-01T00:00:00.000Z"},
        )

    decision = await _client(handler).check(
        tenant_id="t1", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP"
    )

    assert decision == ConsentDecision(
        allowed=True, grant_id="grant-1", expires_at="2027-01-01T00:00:00.000Z"
    )


@pytest.mark.asyncio
async def test_denied_decision_carries_a_reason_and_no_unavailable_flag() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"allowed": False, "reason": "no_grant"})

    decision = await _client(handler).check(
        tenant_id="t1", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP"
    )

    assert decision.allowed is False
    assert decision.reason == "no_grant"
    assert decision.unavailable is False


@pytest.mark.asyncio
async def test_gateway_unreachable_fails_closed_as_unavailable_never_allowed() -> None:
    """R4 — a transport failure must deny AND be distinguishable from a real denial."""

    def boom(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("gateway unreachable")

    decision = await _client(boom).check(
        tenant_id="t1", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP"
    )

    assert decision.allowed is False
    assert decision.unavailable is True
    assert decision.reason is None


@pytest.mark.asyncio
async def test_non_2xx_response_fails_closed_as_unavailable() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"message": "internal error"})

    decision = await _client(handler).check(
        tenant_id="t1", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP"
    )

    assert decision.allowed is False
    assert decision.unavailable is True


@pytest.mark.asyncio
async def test_cache_key_is_tenant_leading_and_per_purpose() -> None:
    """Same patient, different tenant OR different purpose ⇒ separate cache entries."""
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        import json

        payload = json.loads(body)
        calls.append(payload)
        return httpx.Response(200, json={"allowed": True})

    client = _client(handler)
    await client.check(tenant_id="t1", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP")
    await client.check(
        tenant_id="t1", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP"
    )  # cache hit
    await client.check(
        tenant_id="t2", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP"
    )  # different tenant
    await client.check(
        tenant_id="t1", external_patient_id="p1", purpose="HISTORY_RETRIEVAL"
    )  # different purpose

    assert len(calls) == 3  # NOT 4 — the repeat call was a cache hit


@pytest.mark.asyncio
async def test_ttl_expiry_triggers_a_refetch() -> None:
    now = {"t": 0.0}
    served = {"allowed": True}

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"allowed": served["allowed"]})

    client = _client(handler, ttl_s=10, time_func=lambda: now["t"])

    d1 = await client.check(
        tenant_id="t1", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP"
    )
    assert d1.allowed is True

    # Revoke happens; still within TTL ⇒ stale cached value served (bounded staleness).
    served["allowed"] = False
    now["t"] = 5.0
    d2 = await client.check(
        tenant_id="t1", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP"
    )
    assert d2.allowed is True

    # Past TTL ⇒ refetch observes the revoke.
    now["t"] = 15.0
    d3 = await client.check(
        tenant_id="t1", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP"
    )
    assert d3.allowed is False


@pytest.mark.asyncio
async def test_a_failure_is_negative_cached_for_the_ttl_window() -> None:
    """A down gateway costs at most one attempt per window per key."""
    now = {"t": 0.0}
    attempts = {"n": 0}

    def boom(_request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        raise httpx.ConnectError("down")

    client = _client(boom, ttl_s=10, time_func=lambda: now["t"])

    await client.check(tenant_id="t1", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP")
    await client.check(tenant_id="t1", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP")
    assert attempts["n"] == 1

    now["t"] = 15.0
    await client.check(tenant_id="t1", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP")
    assert attempts["n"] == 2


@pytest.mark.asyncio
async def test_clear_cache_forces_a_refetch() -> None:
    attempts = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(200, json={"allowed": True})

    client = _client(handler)
    await client.check(tenant_id="t1", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP")
    client.clear_cache()
    await client.check(tenant_id="t1", external_patient_id="p1", purpose="EXTERNAL_TOOL_LOOKUP")

    assert attempts["n"] == 2


@pytest.mark.asyncio
async def test_request_body_carries_scope_and_context_when_supplied() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen.update(json.loads(request.read()))
        return httpx.Response(200, json={"allowed": True})

    await _client(handler).check(
        tenant_id="t1",
        external_patient_id="p1",
        purpose="EXTERNAL_TOOL_LOOKUP",
        scope={"dateRangeDays": 30},
        consultation_id="c1",
        tool_name="terminology.lookup",
    )

    assert seen == {
        "tenantId": "t1",
        "externalPatientId": "p1",
        "purpose": "EXTERNAL_TOOL_LOOKUP",
        "scope": {"dateRangeDays": 30},
        "consultationId": "c1",
        "toolName": "terminology.lookup",
    }


def test_build_consent_client_uses_the_configured_prefix_and_shared_token() -> None:
    from harness.core.config import get_settings
    from harness.core.consent_client import build_consent_client

    settings = get_settings()
    client = build_consent_client()

    assert (
        client._base_url == f"{settings.api_base_url.rstrip('/')}{settings.consent_internal_prefix}"
    )  # noqa: SLF001
    assert client._token == settings.harness_service_token.get_secret_value()  # noqa: SLF001
    assert client._ttl_s == settings.consent_cache_ttl_seconds  # noqa: SLF001
