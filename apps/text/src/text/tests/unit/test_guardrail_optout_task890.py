"""TASK-890 §3.14 (OD-R) — the tenant's per-call guardrail opt-out, in apps/text.

Guardrail POLICY is untouched: the eight catalogue checks, ``TenantGuardrailPolicy`` and the
``guardrail.*`` routing selection stay platform-managed and resolve inside apps/guardrail. What
changes here is ONE question — for THIS call, does the platform's guardrail run — pushed on the
request as ``guardrail_policy.enabled`` and folded over the platform posture.

Three properties this suite pins, and every one of them is a safety property:

1. **The platform switch is the FLOOR.** A pushed ``false`` turns both gates off for that call; a
   pushed ``true`` can NEVER turn a platform-off switch back on. The opt-out only ever subtracts.
2. **The two skip reasons are DISTINCT strings.** ``external_guardrail_disabled`` (the platform
   kill switch) and ``tenant_opted_out`` (a tenant decision on the record) must never be confused:
   one makes every opt-out moot, the other is what the ledger attributes to the tenant.
3. **The fail posture is untouched.** There is still no ``fail_open`` anywhere: an errored
   guardrail can never answer ``allowed: True``.
"""

from __future__ import annotations

import inspect
import re
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core.guardrail_posture import (
    GuardrailPosture,
    resolve_posture,
    tenant_opted_out,
)
from text.models.requests import GuardrailPolicyOverride
from text.services.external_guardrail import (
    GUARDRAIL_TENANT_OPTED_OUT_REASON,
    ExternalGuardrailClient,
)

# ── 1. The request field ────────────────────────────────────────────────────


def test_guardrail_policy_override_carries_a_tri_state_enabled():
    # `None` is NO OPINION and is not the same as `False`; the block's own rule.
    assert GuardrailPolicyOverride().enabled is None
    assert GuardrailPolicyOverride(enabled=False).enabled is False
    assert GuardrailPolicyOverride(enabled=True).enabled is True


# ── 2. resolve_posture: the platform switch is the floor ────────────────────


def test_tenant_false_turns_the_gate_off():
    resolved = resolve_posture(
        GuardrailPosture(enabled=True), GuardrailPolicyOverride(enabled=False)
    )
    assert resolved.enabled is False
    assert resolved.opted_out is True


def test_tenant_true_cannot_revive_a_platform_off_switch():
    # THE floor. A tenant may only ever opt OUT.
    resolved = resolve_posture(
        GuardrailPosture(enabled=False), GuardrailPolicyOverride(enabled=True)
    )
    assert resolved.enabled is False
    # Not the tenant's doing: the platform switch is off, so nobody's opt-out was consulted.
    assert resolved.opted_out is False


def test_no_opinion_inherits_the_platform_posture():
    assert (
        resolve_posture(GuardrailPosture(enabled=True), GuardrailPolicyOverride()).enabled is True
    )
    assert (
        resolve_posture(GuardrailPosture(enabled=False), GuardrailPolicyOverride()).enabled is False
    )
    assert resolve_posture(GuardrailPosture(enabled=True), None).enabled is True


def test_the_other_pushed_fields_still_fold_the_same_way():
    resolved = resolve_posture(
        GuardrailPosture(enabled=True, require_medical=True, include_reasoning=False),
        GuardrailPolicyOverride(enabled=False, require_medical=False, include_reasoning=True),
    )
    assert resolved.require_medical is False
    assert resolved.include_reasoning is True
    # Platform tuning is never overridden by the push.
    assert resolved.timeout_s == GuardrailPosture().timeout_s


def test_a_malformed_enabled_reads_as_no_opinion_never_as_an_opt_out():
    class Loose:
        enabled = "false"  # a string, not a boolean

    assert resolve_posture(GuardrailPosture(enabled=True), Loose()).enabled is True
    assert tenant_opted_out(Loose()) is False
    assert tenant_opted_out(GuardrailPolicyOverride(enabled=False)) is True
    assert tenant_opted_out(None) is False


# ── 3. The client: no call, and the RIGHT reason ────────────────────────────


def _client(*, platform_enabled: bool) -> ExternalGuardrailClient:
    http_client = AsyncMock()
    http_client.post = AsyncMock(side_effect=AssertionError("guardrail must not be called"))
    state = MagicMock()
    state.guardrail_posture = GuardrailPosture(enabled=platform_enabled)
    return ExternalGuardrailClient(
        base_url="http://guardrail", http_client=http_client, app_state=state
    )


@pytest.mark.asyncio
async def test_validate_short_circuits_with_tenant_opted_out_and_calls_nothing():
    verdict = await _client(platform_enabled=True).validate(
        "a prompt", tenant_policy=GuardrailPolicyOverride(enabled=False)
    )
    assert verdict["allowed"] is True
    assert verdict["reason"] == GUARDRAIL_TENANT_OPTED_OUT_REASON == "tenant_opted_out"


@pytest.mark.asyncio
async def test_screen_output_short_circuits_with_the_same_reason():
    verdict = await _client(platform_enabled=True).screen_output(
        "a completion", tenant_policy=GuardrailPolicyOverride(enabled=False)
    )
    assert verdict["allowed"] is True
    assert verdict["reason"] == GUARDRAIL_TENANT_OPTED_OUT_REASON


@pytest.mark.asyncio
async def test_the_platform_kill_switch_keeps_its_OWN_distinct_reason():
    # Same observable outcome, different cause — and the ledger prices them differently
    # (`platform_off` vs `opted_out`), so the two strings must never converge.
    for policy in (None, GuardrailPolicyOverride(enabled=True)):
        verdict = await _client(platform_enabled=False).validate("a prompt", tenant_policy=policy)
        assert verdict["reason"] == "external_guardrail_disabled"
        assert verdict["reason"] != GUARDRAIL_TENANT_OPTED_OUT_REASON


# ── 4. The two gate halves honour the opt-out with the client UNWIRED ───────


@pytest.fixture
def mock_provider():
    provider = AsyncMock()
    provider.generate = AsyncMock(
        return_value=("ok", "", {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})
    )
    return provider


@pytest_asyncio.fixture
async def _app_client(mock_provider):
    from text.main import create_app

    clients = []

    async def _build(*, guardrail_client, platform_enabled: bool):
        app = create_app()
        registry = MagicMock()
        registry.get.return_value = mock_provider
        task_manager = AsyncMock()
        task_state = MagicMock()
        task_state.task_id = "task-1"
        task_manager.create_task = AsyncMock(return_value=task_state)
        task_manager.update_task = AsyncMock()
        task_manager.append_chunk = AsyncMock()
        app.state.provider_registry = registry
        app.state.task_manager = task_manager
        app.state.guardrail_client = guardrail_client
        app.state.guardrail_posture = GuardrailPosture(enabled=platform_enabled)
        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        clients.append(client)
        return client

    yield _build
    for client in clients:
        await client.aclose()


@pytest.mark.asyncio
async def test_an_opted_out_call_does_not_503_on_an_unwired_client(_app_client, mock_provider):
    # Enforce posture ON + client unwired is a 503 for everyone else (a misconfiguration must not
    # ship unmoderated PHI). For a call that asked for NO screening there is nothing to be
    # misconfigured about, so it proceeds — and the run is recorded `opted_out`, gateway-side.
    client = await _app_client(guardrail_client=None, platform_enabled=True)

    response = await client.post(
        "/api/v1/generate",
        json={"prompt": "patient note", "model": "m", "guardrail_policy": {"enabled": False}},
    )

    assert response.status_code == 200
    mock_provider.generate.assert_called_once()


@pytest.mark.asyncio
async def test_a_call_that_did_not_opt_out_still_fails_closed_on_an_unwired_client(
    _app_client, mock_provider
):
    client = await _app_client(guardrail_client=None, platform_enabled=True)

    response = await client.post(
        "/api/v1/generate",
        json={"prompt": "patient note", "model": "m", "guardrail_policy": {"enabled": True}},
    )

    assert response.status_code == 503
    mock_provider.generate.assert_not_called()


@pytest.mark.asyncio
async def test_the_pushed_decision_reaches_the_client_verbatim(_app_client):
    guardrail = AsyncMock()
    guardrail.validate = AsyncMock(return_value={"allowed": True})
    guardrail.screen_output = AsyncMock(return_value={"allowed": True})
    client = await _app_client(guardrail_client=guardrail, platform_enabled=True)

    await client.post(
        "/api/v1/generate",
        json={"prompt": "patient note", "model": "m", "guardrail_policy": {"enabled": False}},
    )

    policy = guardrail.validate.await_args.kwargs["tenant_policy"]
    assert policy.enabled is False


# ── 5. The fail posture is still not configurable ───────────────────────────


def test_no_fail_open_field_exists_anywhere_in_the_posture_or_the_request():
    # The three modules MENTION `fail_open` — each says why it does not exist — so the
    # assertion is about a DECLARATION (`fail_open:` / `fail_open =`), never the word.
    import text.core.guardrail_posture as posture_module
    import text.models.requests as requests_module
    import text.services.external_guardrail as guardrail_module

    declaration = re.compile(r"^\s*fail_open\s*[:=]", re.MULTILINE)
    for module in (posture_module, requests_module, guardrail_module):
        assert declaration.search(inspect.getsource(module)) is None, module.__name__
    assert not hasattr(GuardrailPosture(), "fail_open")
    assert "fail_open" not in GuardrailPolicyOverride.model_fields
