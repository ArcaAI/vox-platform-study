"""Unit tests for the Text ExternalGuardrailClient.

httpx is fully mocked — covers tenant-header propagation, the medical verdict
mapping, and the degrade-safe → fail-CLOSED posture when the guardrail is
unreachable: a transient blip is absorbed by a bounded retry, a sustained outage
fails closed, and an errored guardrail can NEVER return ``allowed: True``.

lane B moved the POSTURE off env, split by cardinality (owner decision
D-1): the platform switch and retry budget arrive on the PULL channel, and
`require_medical` / `include_reasoning` are PUSHED per request because they
legitimately differ between tenants. The client's construction takes only the
guardrail's ADDRESS, so these tests set the posture the way production does.

What is NOT configurable, here or anywhere: the fail posture. There is no
`fail_open`, and the tests below prove there is no way to construct one.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from text.core.guardrail_posture import GuardrailPosture
from text.models.requests import GuardrailPolicyOverride
from text.services.external_guardrail import ExternalGuardrailClient

_BASE_URL = "http://guardrail.test"


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _RecordingClient:
    """Records the POST and returns a canned medical-validate body."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.calls: list[dict[str, Any]] = []

    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: ANN001
        self.calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        return _FakeResponse(self.payload)


class _RaisingClient:
    def __init__(self) -> None:
        self.calls = 0

    async def post(self, *args: Any, **kwargs: Any):
        self.calls += 1
        raise RuntimeError("guardrail unreachable")


class _RaiseThenSucceedClient:
    """Raises ``fail_times`` times, then returns a canned medical-validate body."""

    def __init__(self, fail_times: int, payload: dict[str, Any]) -> None:
        self.fail_times = fail_times
        self.payload = payload
        self.calls = 0

    async def post(self, *args: Any, **kwargs: Any):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise RuntimeError("guardrail blip")
        return _FakeResponse(self.payload)


def _client(
    http_client: Any,
    *,
    service_token: str = "svc-token",
    **posture: Any,
) -> ExternalGuardrailClient:
    """A client whose PLATFORM posture is whatever the control plane last served.

    `enabled=True` by default because every test below except the bypass one is
    about what happens when moderation runs; the floor is False so a checkout
    with no control plane and no guardrail peer still boots.
    """
    posture.setdefault("enabled", True)
    state = SimpleNamespace(guardrail_posture=GuardrailPosture(**posture))
    return ExternalGuardrailClient(
        base_url=_BASE_URL,
        http_client=http_client,
        service_token=service_token,
        app_state=state,
    )


# --- the platform switch (PULL channel) -------------------------------------


@pytest.mark.asyncio
async def test_disabled_short_circuits_without_http_call() -> None:
    http = _RecordingClient({"is_medical": True})
    client = _client(http, enabled=False)

    result = await client.validate("some prompt")

    assert result["allowed"] is True
    assert result["reason"] == "external_guardrail_disabled"
    assert http.calls == []


@pytest.mark.asyncio
async def test_the_switch_is_read_per_call_not_snapshotted_at_construction() -> None:
    """A platform admin turning moderation on must take effect on the NEXT
    request, not the next restart — that is the whole point of moving it off env."""
    http = _RecordingClient({"is_medical": True})
    state = SimpleNamespace(guardrail_posture=GuardrailPosture(enabled=False))
    client = ExternalGuardrailClient(
        base_url=_BASE_URL, http_client=http, service_token="svc-token", app_state=state
    )

    assert (await client.validate("note"))["reason"] == "external_guardrail_disabled"
    assert http.calls == []

    state.guardrail_posture = GuardrailPosture(enabled=True)
    await client.validate("note")
    assert len(http.calls) == 1


@pytest.mark.asyncio
async def test_an_unanswering_control_plane_keeps_the_floor() -> None:
    """No served posture ⇒ the in-code floor, which is `enabled=False`. The same
    dev/CI bypass `TEXT_EXTERNAL_GUARDRAIL_ENABLED=false` used to give."""
    http = _RecordingClient({"is_medical": True})
    client = ExternalGuardrailClient(
        base_url=_BASE_URL, http_client=http, service_token="", app_state=None
    )

    assert (await client.validate("note"))["reason"] == "external_guardrail_disabled"
    assert http.calls == []


# --- verdict mapping --------------------------------------------------------


@pytest.mark.asyncio
async def test_medical_content_is_allowed() -> None:
    http = _RecordingClient({"is_medical": True, "confidence": 0.95})
    client = _client(http)

    result = await client.validate("patient chest pain")

    assert result["allowed"] is True
    assert result["is_medical"] is True
    assert result["confidence"] == 0.95


@pytest.mark.asyncio
async def test_non_medical_blocked_when_require_medical() -> None:
    http = _RecordingClient({"is_medical": False, "confidence": 0.1})
    client = _client(http, require_medical=True)

    result = await client.validate("schedule a meeting")

    assert result["allowed"] is False
    assert result["is_medical"] is False


@pytest.mark.asyncio
async def test_non_medical_allowed_when_platform_does_not_require_medical() -> None:
    http = _RecordingClient({"is_medical": False})
    client = _client(http, require_medical=False)

    result = await client.validate("schedule a meeting")

    assert result["allowed"] is True


# --- the tenant's own policy (PUSH channel) ---------------------------------


class TestTenantPolicyFoldsOverThePlatformDefault:
    """`require_medical` is the field that could never be an env var.

    A non-clinical tenant needs it off while every other tenant keeps it on; a
    process-wide boolean can express only one of those. Resolution is the
    platform-wide order — tenant → platform default — widening only on ABSENCE.
    """

    @pytest.mark.asyncio
    async def test_a_tenant_may_opt_out_of_clinical_enforcement(self) -> None:
        http = _RecordingClient({"is_medical": False})
        client = _client(http, require_medical=True)

        result = await client.validate(
            "schedule a meeting",
            tenant_policy=GuardrailPolicyOverride(require_medical=False),
        )

        assert result["allowed"] is True

    @pytest.mark.asyncio
    async def test_a_tenant_may_opt_in_where_the_platform_does_not_require_it(self) -> None:
        http = _RecordingClient({"is_medical": False})
        client = _client(http, require_medical=False)

        result = await client.validate(
            "schedule a meeting",
            tenant_policy=GuardrailPolicyOverride(require_medical=True),
        )

        assert result["allowed"] is False

    @pytest.mark.asyncio
    async def test_no_opinion_is_not_false(self) -> None:
        """`None` means "the tenant said nothing", which must inherit — not be
        flattened into `False` and silently disable clinical enforcement."""
        http = _RecordingClient({"is_medical": False})
        client = _client(http, require_medical=True)

        result = await client.validate(
            "schedule a meeting",
            tenant_policy=GuardrailPolicyOverride(include_reasoning=True),
        )

        assert result["allowed"] is False

    @pytest.mark.asyncio
    async def test_include_reasoning_reaches_the_wire(self) -> None:
        http = _RecordingClient({"is_medical": True})
        client = _client(http, include_reasoning=False)

        await client.validate(
            "patient note", tenant_policy=GuardrailPolicyOverride(include_reasoning=True)
        )

        assert http.calls[0]["json"]["include_reasoning"] is True

    @pytest.mark.asyncio
    async def test_a_tenant_cannot_switch_moderation_off(self) -> None:
        """`enabled` is PLATFORM-scope: a tenant policy carries no such field, so
        there is no request shape that turns its own moderation off."""
        assert "enabled" not in GuardrailPolicyOverride.model_fields


# --- headers and body -------------------------------------------------------


@pytest.mark.asyncio
async def test_tenant_id_forwarded_as_header() -> None:
    http = _RecordingClient({"is_medical": True})
    client = _client(http)

    await client.validate("patient note", tenant_id="tenant-xyz")

    assert http.calls[0]["headers"]["X-Tenant-Id"] == "tenant-xyz"


@pytest.mark.asyncio
async def test_tenant_header_absent_when_no_tenant() -> None:
    http = _RecordingClient({"is_medical": True})
    client = _client(http)

    await client.validate("patient note")

    assert "X-Tenant-Id" not in http.calls[0]["headers"]


@pytest.mark.asyncio
async def test_service_token_forwarded_as_header() -> None:
    http = _RecordingClient({"is_medical": True})
    client = _client(http, service_token="svc-token")

    await client.validate("patient note")

    assert http.calls[0]["headers"]["X-Service-Token"] == "svc-token"


@pytest.mark.asyncio
async def test_system_prompt_is_prepended_to_text() -> None:
    http = _RecordingClient({"is_medical": True})
    client = _client(http)

    await client.validate("the prompt", system_prompt="the system")

    assert http.calls[0]["json"]["text"] == "the system\n\nthe prompt"


@pytest.mark.asyncio
async def test_the_served_timeout_reaches_the_transport() -> None:
    http = _RecordingClient({"is_medical": True})
    client = _client(http, timeout_s=3)

    await client.validate("patient note")

    assert http.calls[0]["timeout"] == 3


# --- Degrade-safe → fail-CLOSED posture -------------------------------------


@pytest.mark.asyncio
async def test_fail_closed_blocks_when_guardrail_unreachable() -> None:
    http = _RaisingClient()
    client = _client(http)

    result = await client.validate("patient note")

    assert result["allowed"] is False
    assert result["reason"] == "external_guardrail_unavailable"
    assert "error" in result


@pytest.mark.asyncio
async def test_transient_blip_absorbed_by_bounded_retry() -> None:
    # One transient error then success → the blip is absorbed by the bounded
    # retry and the (medical) verdict is returned. Degrade-safe, NOT a hard fail.
    http = _RaiseThenSucceedClient(fail_times=1, payload={"is_medical": True, "confidence": 0.9})
    client = _client(http, max_retries=2)

    result = await client.validate("patient chest pain")

    assert result["allowed"] is True
    assert result["is_medical"] is True
    assert http.calls == 2  # 1 blip + 1 successful retry


@pytest.mark.asyncio
async def test_sustained_outage_fails_closed_after_bounded_retries() -> None:
    # Every attempt errors → after the bounded retry budget the client
    # fails CLOSED with a deterministic not-allowed verdict — never allowed=True.
    http = _RaisingClient()
    client = _client(http, max_retries=2, retry_backoff_ms=0)

    result = await client.validate("patient note")

    assert result["allowed"] is False
    assert result["reason"] == "external_guardrail_unavailable"
    assert "error" in result
    assert http.calls == 3  # max_retries=2 → 3 bounded attempts


@pytest.mark.asyncio
async def test_retry_budget_is_control_plane_driven_no_retry() -> None:
    # max_retries=0 → exactly one attempt (no retry), then fail closed.
    http = _RaisingClient()
    client = _client(http, max_retries=0)

    result = await client.validate("patient note")

    assert result["allowed"] is False
    assert http.calls == 1


@pytest.mark.asyncio
async def test_retry_budget_is_control_plane_driven_bounded() -> None:
    # max_retries=3 → exactly 4 bounded attempts, then fail closed
    # (bounded — never an unbounded retry loop that bricks a request).
    http = _RaisingClient()
    client = _client(http, max_retries=3, retry_backoff_ms=0)

    result = await client.validate("patient note")

    assert result["allowed"] is False
    assert http.calls == 4


class TestFailOpenCannotBeConstructed:
    """The fail-open foot-gun is retired, and moving the posture to the control
    plane must not quietly reintroduce it: neither tier has such a field, so
    there is no value an admin or a tenant could set to ship unmoderated PHI on
    an outage."""

    def test_no_fail_open_on_the_platform_posture(self) -> None:
        assert "fail_open" not in GuardrailPosture.__dataclass_fields__

    def test_no_fail_open_on_a_tenant_policy(self) -> None:
        assert "fail_open" not in GuardrailPolicyOverride.model_fields

    def test_no_fail_open_setting_exists(self) -> None:
        from text.core.config import ExternalGuardrailConfig

        assert "fail_open" not in ExternalGuardrailConfig.model_fields
