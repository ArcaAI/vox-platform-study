"""``call_mcp_tool`` activity SECURITY tests (hermetic; no SDK, no network).

The five security invariants, each fail-closed / degrade-safe:

1. Allowlist denial RAISES before any network call (deny-all when the server has no
   allowlist; the tenant policy allowlist narrows the server set).
2. PHI-bearing args + an ``external`` server are BLOCKED fail-closed BEFORE any network
   call.
3. A server 5xx records an ``ERROR`` trajectory step and DEGRADES (never raises/crashes),
   so the workflow can fall back to reduced assurance.
4. The Vault-resolved credential NEVER appears in the trajectory or the result (scrubbed).
5. A tool result over the size cap is claim-checked (offloaded out of Temporal history).

All exercised through the REAL activity body in an ``ActivityEnvironment`` with the MCP
client / token resolver / trajectory client / PHI redactor monkeypatched.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from harness.core.config import Settings
from harness.guards.phi import PhiEgressBlocked
from harness.guards.phi.redactor import RedactedEntity, RedactionResult
from harness.temporal import activities
from harness.temporal.models import CallMcpToolInput, McpServerConfig, TrajectoryContext
from harness.tools.mcp_client import McpClientError, McpToolResult

# ---------------------------------------------------------------------------
# Stubs / builders
# ---------------------------------------------------------------------------


class _RecordingClient:
    """MCP client stub: records every call so we can assert network was/wasn't reached."""

    def __init__(self, *, result: McpToolResult | None = None, exc: Exception | None = None) -> None:
        self._result = result
        self._exc = exc
        self.calls: list[dict[str, Any]] = []

    async def call_tool(self, *, base_url: str, tool: str, args: dict, auth_token: str | None = None):
        self.calls.append(
            {"base_url": base_url, "tool": tool, "args": args, "auth_token": auth_token}
        )
        if self._exc is not None:
            raise self._exc
        return self._result


class _FakeRedactor:
    def __init__(self, *, entities: int = 0) -> None:
        self._entities = entities

    def redact(self, text: str) -> RedactionResult:
        ents = [
            RedactedEntity(entity_type="PERSON", start=0, end=1, score=0.99)
            for _ in range(self._entities)
        ]
        return RedactionResult(text=text, entities=ents)


class _CapTraj:
    def __init__(self) -> None:
        self.steps: list[Any] = []

    async def report_trajectory(self, steps, *, idempotency_key: str | None = None):
        self.steps.extend(steps)

        class _R:
            accepted = len(steps)

        return _R()


def _server(**kw: Any) -> McpServerConfig:
    base: dict[str, Any] = {
        "id": "srv-1",
        "name": "fhir-term",
        "base_url": "http://terminology.local/mcp",
        "transport": "streamable-http",
        "auth_ref": None,
        "tool_allowlist": ["validate_codes"],
        "phi_boundary": "in-boundary",
        "enabled": True,
    }
    base.update(kw)
    return McpServerConfig(**base)


def _traj() -> TrajectoryContext:
    return TrajectoryContext(tenant_id="t-1", consultation_id="c-1", correlation_id="corr-1", seq=0)


def _input(**kw: Any) -> CallMcpToolInput:
    base: dict[str, Any] = {
        "server": _server(),
        "tool": "validate_codes",
        "args": {"codes": ["I10"]},
        "policy_tool_allowlist": None,
        "phi_enabled": True,
        "phi_fail_closed": True,
        "trajectory": _traj(),
    }
    base.update(kw)
    return CallMcpToolInput(**base)


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


def _wire(monkeypatch, *, client, cap, settings=None, token=None, redactor=None):
    monkeypatch.setattr(activities, "get_settings", lambda: settings or Settings())
    monkeypatch.setattr(activities, "_mcp_client", lambda s: client)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)
    monkeypatch.setattr(activities, "_resolve_mcp_token", lambda s, ref: token)
    monkeypatch.setattr(activities, "_phi_redactor", lambda: redactor or _FakeRedactor())


# ---------------------------------------------------------------------------
# 1) Allowlist denial — RAISES before any network call
# ---------------------------------------------------------------------------


class TestAllowlistDeny:
    @pytest.mark.asyncio
    async def test_tool_not_in_server_allowlist_raises_before_network(self, env, monkeypatch):
        client = _RecordingClient(result=McpToolResult(content="ok"))
        cap = _CapTraj()
        _wire(monkeypatch, client=client, cap=cap)
        with pytest.raises(ApplicationError) as ei:
            await env.run(activities.call_mcp_tool, _input(tool="delete_everything"))
        assert ei.value.type == "McpToolNotAllowed"
        assert client.calls == []  # network NEVER reached
        assert cap.steps[-1].status == "ERROR"
        assert cap.steps[-1].error_code == "tool_not_allowed"

    @pytest.mark.asyncio
    async def test_policy_allowlist_intersection_denies(self, env, monkeypatch):
        # Server allows validate_codes, but the tenant policy allowlist excludes it.
        client = _RecordingClient(result=McpToolResult(content="ok"))
        cap = _CapTraj()
        _wire(monkeypatch, client=client, cap=cap)
        with pytest.raises(ApplicationError):
            await env.run(
                activities.call_mcp_tool,
                _input(policy_tool_allowlist=["some_other_tool"]),
            )
        assert client.calls == []

    @pytest.mark.asyncio
    async def test_server_without_allowlist_denies_all(self, env, monkeypatch):
        client = _RecordingClient(result=McpToolResult(content="ok"))
        cap = _CapTraj()
        _wire(monkeypatch, client=client, cap=cap)
        with pytest.raises(ApplicationError):
            await env.run(
                activities.call_mcp_tool, _input(server=_server(tool_allowlist=None))
            )
        assert client.calls == []


# ---------------------------------------------------------------------------
# 2) PHI-bearing args + external boundary — BLOCKED fail-closed before network
# ---------------------------------------------------------------------------


class TestPhiEgressBlock:
    @pytest.mark.asyncio
    async def test_phi_args_external_blocked_before_network(self, env, monkeypatch):
        client = _RecordingClient(result=McpToolResult(content="ok"))
        cap = _CapTraj()
        # External server + a redactor that detects PHI ⇒ fail-closed block.
        _wire(monkeypatch, client=client, cap=cap, redactor=_FakeRedactor(entities=2))
        with pytest.raises(PhiEgressBlocked):
            await env.run(
                activities.call_mcp_tool,
                _input(
                    server=_server(phi_boundary="external"),
                    args={"note": "John Doe MRN: 884512"},
                ),
            )
        assert client.calls == []  # blocked BEFORE egress
        assert cap.steps[-1].status == "ERROR"
        assert cap.steps[-1].error_code == "phi_egress_blocked"

    @pytest.mark.asyncio
    async def test_in_boundary_phi_not_screened(self, env, monkeypatch):
        # An in-boundary (self-hosted) server is not an egress ⇒ PHI is not screened/blocked.
        client = _RecordingClient(result=McpToolResult(content="ok"))
        cap = _CapTraj()
        _wire(monkeypatch, client=client, cap=cap, redactor=_FakeRedactor(entities=9))
        result = await env.run(
            activities.call_mcp_tool,
            _input(server=_server(phi_boundary="in-boundary"), args={"note": "John Doe"}),
        )
        assert result.ok is True
        assert len(client.calls) == 1


# ---------------------------------------------------------------------------
# 3) Server 5xx — ERROR step + DEGRADE (never raises/crashes)
# ---------------------------------------------------------------------------


class TestServerErrorDegrades:
    @pytest.mark.asyncio
    async def test_server_5xx_records_error_and_degrades(self, env, monkeypatch):
        client = _RecordingClient(exc=McpClientError("boom", is_server_error=True, status=503))
        cap = _CapTraj()
        _wire(monkeypatch, client=client, cap=cap)
        result = await env.run(activities.call_mcp_tool, _input())
        # No raise — degraded result the workflow OR-s into reduced assurance.
        assert result.ok is False
        assert result.degraded is True
        assert result.error_code == "server_error"
        assert len(client.calls) == 1  # network was attempted
        assert cap.steps[-1].status == "ERROR"
        assert cap.steps[-1].error_code == "server_error"

    @pytest.mark.asyncio
    async def test_tool_error_result_degrades(self, env, monkeypatch):
        client = _RecordingClient(result=McpToolResult(content="bad", is_error=True))
        cap = _CapTraj()
        _wire(monkeypatch, client=client, cap=cap)
        result = await env.run(activities.call_mcp_tool, _input())
        assert result.degraded is True
        assert result.error_code == "tool_error"

    @pytest.mark.asyncio
    async def test_disabled_server_skips_without_network(self, env, monkeypatch):
        client = _RecordingClient(result=McpToolResult(content="ok"))
        cap = _CapTraj()
        _wire(monkeypatch, client=client, cap=cap)
        result = await env.run(activities.call_mcp_tool, _input(server=_server(enabled=False)))
        assert result.degraded is True
        assert result.error_code == "server_disabled"
        assert client.calls == []
        assert cap.steps[-1].status == "SKIPPED"


# ---------------------------------------------------------------------------
# 4) Credential material NEVER appears in trajectory / result (scrubbing)
# ---------------------------------------------------------------------------


class TestCredentialScrub:
    @pytest.mark.asyncio
    async def test_token_resolved_but_never_leaks(self, env, monkeypatch):
        secret = "SUPER_SECRET_TOKEN_do_not_leak"
        client = _RecordingClient(result=McpToolResult(content="{\"valid\": true}"))
        cap = _CapTraj()
        _wire(
            monkeypatch,
            client=client,
            cap=cap,
            token=secret,
            settings=Settings(),
        )
        result = await env.run(
            activities.call_mcp_tool,
            _input(server=_server(auth_ref="secret/data/harness/mcp/fhir-term")),
        )
        assert result.ok is True
        # The token WAS resolved + handed to the client (proves the auth path works)...
        assert client.calls[0]["auth_token"] == secret
        # ...but it NEVER appears in the persisted trajectory or the returned result.
        traj_blob = json.dumps([s.model_dump() for s in cap.steps], default=str)
        assert secret not in traj_blob
        assert secret not in json.dumps(result.model_dump(), default=str)


# ---------------------------------------------------------------------------
# 5) Result over the size cap — claim-checked (offloaded)
# ---------------------------------------------------------------------------


class TestSizeCapClaimCheck:
    @pytest.mark.asyncio
    async def test_large_result_is_claim_checked(self, env, monkeypatch):
        big = "x" * 500
        client = _RecordingClient(result=McpToolResult(content=big))
        cap = _CapTraj()
        settings = Settings(
            mcp={"max_result_bytes": 64},
            claim_check={"enabled": True, "store": "memory"},
        )
        _wire(monkeypatch, client=client, cap=cap, settings=settings)
        result = await env.run(activities.call_mcp_tool, _input())
        assert result.ok is True
        assert result.content == ""  # inline emptied — blob kept OUT of history
        assert result.content_ref is not None
        step = cap.steps[-1]
        assert step.status == "OK"
        assert step.stats["offloaded"] is True
        assert step.stats["result_bytes"] == 500
        assert step.payload_ref is not None

    @pytest.mark.asyncio
    async def test_large_result_truncates_when_claim_check_off(self, env, monkeypatch):
        big = "y" * 500
        client = _RecordingClient(result=McpToolResult(content=big))
        cap = _CapTraj()
        settings = Settings(
            mcp={"max_result_bytes": 64},
            claim_check={"enabled": False},
        )
        _wire(monkeypatch, client=client, cap=cap, settings=settings)
        result = await env.run(activities.call_mcp_tool, _input())
        assert result.ok is True
        assert result.content_ref is None
        assert result.truncated is True
        assert len(result.content.encode("utf-8")) <= 64

    @pytest.mark.asyncio
    async def test_small_result_inline_ok(self, env, monkeypatch):
        client = _RecordingClient(result=McpToolResult(content="{\"valid\": true}"))
        cap = _CapTraj()
        _wire(monkeypatch, client=client, cap=cap)
        result = await env.run(activities.call_mcp_tool, _input())
        assert result.ok is True
        assert result.content == "{\"valid\": true}"
        assert result.content_ref is None
        assert cap.steps[-1].status == "OK"
        assert cap.steps[-1].stats["offloaded"] is False
