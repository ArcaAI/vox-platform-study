"""TASK-846 D-3 — the ``call_mcp_tool`` activity's SSRF egress gate (hermetic).

``McpServer.baseUrl`` is TENANT-AUTHORED (OD-7). Inside a k3s cluster an unconstrained
value reaches the Kubernetes API, Vault on loopback, and the cloud metadata endpoint.
The allow-list is a PLATFORM setting (``mcp.egress.allowedHosts``, `global-kv`,
``failMode: 'closed'``) delivered over the effective-config pull route.

What this file pins, in the activity rather than the client:

* a denied destination RAISES before any network call, and before the Vault credential
  for that server is ever resolved;
* an UNRESOLVED allow-list denies (the control plane being unreachable is not consent);
* the trajectory records the denial with a distinct ``egress_blocked`` code, so an
  operator can tell "misconfigured/hostile destination" from "tool not allowed";
* the allow-list is actually handed to the client, which is what arms the per-request
  pinning inside the transport.

The RULE itself (ranges, matching, IPv6 unwrapping) belongs to ``test_egress_guard.py``,
driven by the fixture shared with the TypeScript implementation.
"""

from __future__ import annotations

from typing import Any

import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from harness.core.config import Settings
from harness.temporal import activities
from harness.temporal.models import CallMcpToolInput, McpServerConfig, TrajectoryContext
from harness.tools.mcp_client import McpToolResult

ALLOWED_HOST = "mcp.partner.example.com"
ALLOWED_URL = f"https://{ALLOWED_HOST}/mcp"
METADATA_URL = "http://169.254.169.254/latest/meta-data/"
VAULT_URL = "http://127.0.0.1:8200/"


class _RecordingClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def call_tool(self, *, base_url: str, tool: str, args: dict, auth_token: str | None = None):
        self.calls.append({"base_url": base_url, "auth_token": auth_token})
        return McpToolResult(content="ok", is_error=False)


class _CapTraj:
    def __init__(self) -> None:
        self.steps: list[Any] = []

    async def report_trajectory(self, steps, *, idempotency_key: str | None = None):
        self.steps.extend(steps)

        class _R:
            accepted = len(steps)

        return _R()


class _AllowAllConsent:
    async def check(self, **kwargs: Any):
        from harness.core.consent_client import ConsentDecision

        return ConsentDecision(allowed=True, unavailable=False, reason=None)


class _FakeRedactor:
    def redact(self, text: str):
        from harness.guards.phi.redactor import RedactionResult

        return RedactionResult(text=text, entities=[])


def _server(base_url: str) -> McpServerConfig:
    return McpServerConfig(
        id="srv-1",
        name="fhir-term",
        base_url=base_url,
        transport="streamable-http",
        auth_ref="secret/data/mcp/term",
        tool_allowlist=["validate_codes"],
        phi_boundary="in-boundary",
        enabled=True,
    )


def _input(base_url: str) -> CallMcpToolInput:
    return CallMcpToolInput(
        server=_server(base_url),
        tool="validate_codes",
        args={"codes": ["I10"]},
        policy_tool_allowlist=None,
        phi_enabled=True,
        phi_fail_closed=True,
        tenant_id="t-1",
        external_patient_id="PAT-1",
        consultation_id="c-1",
        trajectory=TrajectoryContext(
            tenant_id="t-1", consultation_id="c-1", correlation_id="corr-1", seq=0
        ),
    )


def _resolver(hostname: str) -> list[str]:
    return {ALLOWED_HOST: ["203.0.113.10"]}.get(hostname.lower(), [])


def _wire(monkeypatch, *, client, cap, allowed_hosts, token_calls: list[str] | None = None):
    monkeypatch.setattr(activities, "get_settings", lambda: Settings())
    monkeypatch.setattr(activities, "_mcp_client", lambda s, hosts=None: client)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)
    monkeypatch.setattr(activities, "_consent_client", lambda s: _AllowAllConsent())
    monkeypatch.setattr(activities, "_phi_redactor", lambda: _FakeRedactor())
    monkeypatch.setattr(activities, "_mcp_egress_allowed_hosts", lambda: _async(allowed_hosts))
    monkeypatch.setattr(activities, "_mcp_egress_resolver", lambda: _resolver)

    async def _token(_settings, ref):
        if token_calls is not None:
            token_calls.append(ref)
        return "tok"

    monkeypatch.setattr(activities, "_resolve_mcp_token", _token)


async def _async(value):
    return value


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


class TestEgressDenialRaisesBeforeNetwork:
    @pytest.mark.asyncio
    async def test_metadata_endpoint_is_refused(self, env, monkeypatch):
        client, cap, tokens = _RecordingClient(), _CapTraj(), []
        _wire(monkeypatch, client=client, cap=cap, allowed_hosts=[ALLOWED_HOST], token_calls=tokens)

        with pytest.raises(ApplicationError) as ei:
            await env.run(activities.call_mcp_tool, _input(METADATA_URL))

        assert ei.value.type == "McpEgressBlocked"
        assert ei.value.non_retryable is True
        assert client.calls == []  # never dialled
        assert tokens == []  # and no credential was even resolved for it

    @pytest.mark.asyncio
    async def test_vault_on_loopback_is_refused(self, env, monkeypatch):
        client, cap = _RecordingClient(), _CapTraj()
        _wire(monkeypatch, client=client, cap=cap, allowed_hosts=[ALLOWED_HOST])
        with pytest.raises(ApplicationError):
            await env.run(activities.call_mcp_tool, _input(VAULT_URL))
        assert client.calls == []

    @pytest.mark.asyncio
    async def test_denial_records_a_distinct_trajectory_code(self, env, monkeypatch):
        client, cap = _RecordingClient(), _CapTraj()
        _wire(monkeypatch, client=client, cap=cap, allowed_hosts=[ALLOWED_HOST])

        with pytest.raises(ApplicationError):
            await env.run(activities.call_mcp_tool, _input(METADATA_URL))

        codes = [getattr(s, "error_code", None) for s in cap.steps]
        assert "egress_blocked" in codes, f"got {codes}"

    @pytest.mark.asyncio
    async def test_trajectory_does_not_carry_the_full_url(self, env, monkeypatch):
        # A connector URL can carry a token in its query string; the trajectory is
        # persisted and widely readable.
        client, cap = _RecordingClient(), _CapTraj()
        _wire(monkeypatch, client=client, cap=cap, allowed_hosts=[ALLOWED_HOST])
        url = "http://169.254.169.254/latest/meta-data/?token=SUPERSECRET"
        with pytest.raises(ApplicationError):
            await env.run(activities.call_mcp_tool, _input(url))
        assert "SUPERSECRET" not in repr(cap.steps)


class TestFailClosed:
    @pytest.mark.asyncio
    async def test_unresolved_allowlist_denies_even_a_legitimate_host(self, env, monkeypatch):
        """A control plane that cannot answer is not consent."""
        client, cap = _RecordingClient(), _CapTraj()
        _wire(monkeypatch, client=client, cap=cap, allowed_hosts=None)

        with pytest.raises(ApplicationError) as ei:
            await env.run(activities.call_mcp_tool, _input(ALLOWED_URL))

        assert ei.value.type == "McpEgressBlocked"
        assert client.calls == []

    @pytest.mark.asyncio
    async def test_empty_allowlist_denies(self, env, monkeypatch):
        client, cap = _RecordingClient(), _CapTraj()
        _wire(monkeypatch, client=client, cap=cap, allowed_hosts=[])
        with pytest.raises(ApplicationError):
            await env.run(activities.call_mcp_tool, _input(ALLOWED_URL))
        assert client.calls == []


class TestAllowedDestinationStillWorks:
    @pytest.mark.asyncio
    async def test_allowed_host_reaches_the_client(self, env, monkeypatch):
        client, cap = _RecordingClient(), _CapTraj()
        _wire(monkeypatch, client=client, cap=cap, allowed_hosts=[ALLOWED_HOST])

        result = await env.run(activities.call_mcp_tool, _input(ALLOWED_URL))

        assert result.ok is True
        assert len(client.calls) == 1
        assert client.calls[0]["base_url"] == ALLOWED_URL

    @pytest.mark.asyncio
    async def test_the_allowlist_is_handed_to_the_client(self, env, monkeypatch):
        """Without this the transport cannot pin, and rebinding is wide open again."""
        seen: dict[str, Any] = {}
        client, cap = _RecordingClient(), _CapTraj()
        _wire(monkeypatch, client=client, cap=cap, allowed_hosts=[ALLOWED_HOST])

        def _factory(settings, hosts=None):
            seen["hosts"] = hosts
            return client

        monkeypatch.setattr(activities, "_mcp_client", _factory)
        await env.run(activities.call_mcp_tool, _input(ALLOWED_URL))

        assert seen["hosts"] == [ALLOWED_HOST]


class TestAllowlistSourcing:
    @pytest.mark.asyncio
    async def test_reads_the_registry_key_from_the_pull_snapshot(self, monkeypatch):
        seen: list[str] = []

        class _Snap:
            def setting(self, key: str):
                seen.append(key)
                return [ALLOWED_HOST]

        async def _snapshot():
            return _Snap()

        monkeypatch.setattr(activities, "_config_snapshot", _snapshot)
        hosts = await activities._mcp_egress_allowed_hosts()

        assert seen == ["mcp.egress.allowedHosts"]
        assert hosts == [ALLOWED_HOST]

    @pytest.mark.asyncio
    async def test_absent_snapshot_yields_none_not_an_empty_allow(self, monkeypatch):
        # `_config_snapshot` returns None when the control plane is unreachable. That
        # must surface as None (⇒ deny), never as [] and never as "no restrictions".
        async def _snapshot():
            return None

        monkeypatch.setattr(activities, "_config_snapshot", _snapshot)
        assert await activities._mcp_egress_allowed_hosts() is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize("malformed", ["a-string", 42, {}, [1], [None]])
    async def test_malformed_setting_yields_none(self, monkeypatch, malformed):
        class _Snap:
            def setting(self, key: str):
                return malformed

        async def _snapshot():
            return _Snap()

        monkeypatch.setattr(activities, "_config_snapshot", _snapshot)
        assert await activities._mcp_egress_allowed_hosts() is None


class TestLateRebindBetweenCheckAndConnect:
    """The destination passed step (2.5), then the resolver's answer CHANGED.

    That is a real DNS rebind, and it is the case the transport-level pinning exists
    for. What is asserted here is the CLASSIFICATION: it must land as the same
    non-retryable `McpEgressBlocked` / `egress_blocked` as an up-front denial, not
    escape as a generic (retryable) failure — retrying a rebind merely re-runs the
    attacker's lookup.
    """

    @pytest.mark.asyncio
    async def test_client_side_egress_block_is_non_retryable_and_recorded(
        self, env, monkeypatch
    ):
        from harness.tools.egress_guard import EgressBlocked, EgressDecision

        class _RebindingClient:
            def __init__(self) -> None:
                self.calls: list[str] = []

            async def call_tool(self, *, base_url, tool, args, auth_token=None):
                self.calls.append(base_url)
                raise EgressBlocked(
                    EgressDecision(
                        allowed=False,
                        host=ALLOWED_HOST,
                        reason="blocked_address",
                        detail="resolved into a restricted range",
                    )
                )

        client, cap = _RebindingClient(), _CapTraj()
        _wire(monkeypatch, client=client, cap=cap, allowed_hosts=[ALLOWED_HOST])

        with pytest.raises(ApplicationError) as ei:
            await env.run(activities.call_mcp_tool, _input(ALLOWED_URL))

        assert ei.value.type == "McpEgressBlocked"
        assert ei.value.non_retryable is True
        assert client.calls == [ALLOWED_URL]  # it DID get as far as the client
        assert "egress_blocked" in [getattr(s, "error_code", None) for s in cap.steps]
