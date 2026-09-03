"""MCP client + fail-closed PHI arg guard (hermetic, no `mcp` SDK, no network).

Covers the two reusable security primitives the ``call_mcp_tool`` activity composes:

* :class:`McpToolClient` — bounded retry semantics + secret-free error normalization
  (a 4xx is non-retryable; a 5xx/timeout retries then raises; the SDK-missing path is a
  coarse :class:`McpClientError`).
* :func:`ensure_mcp_args_safe` — the fail-closed PHI egress screen for OUTBOUND tool
  args: pass-through for an in-boundary/disabled guard, BLOCK on detected PHI / analyzer
  failure for an external server, degrade-open only on an explicit opt-out.
"""

from __future__ import annotations

import pytest

from harness.guards.phi import PhiEgressBlocked, ensure_mcp_args_safe
from harness.guards.phi.redactor import RedactedEntity, RedactionResult
from harness.tools.mcp_client import McpClientError, McpToolClient, McpToolResult


class _FakeRedactor:
    """A stand-in :class:`PhiRedactor` for the arg guard (no Presidio load)."""

    def __init__(self, *, entities: int = 0, raises: bool = False) -> None:
        self._entities = entities
        self._raises = raises
        self.calls: list[str] = []

    def redact(self, text: str) -> RedactionResult:
        self.calls.append(text)
        if self._raises:
            raise RuntimeError("presidio unavailable")
        ents = [
            RedactedEntity(entity_type="PERSON", start=0, end=1, score=0.99)
            for _ in range(self._entities)
        ]
        return RedactionResult(text=text, entities=ents)


# ---------------------------------------------------------------------------
# ensure_mcp_args_safe
# ---------------------------------------------------------------------------


class TestEnsureMcpArgsSafe:
    def test_in_boundary_is_pass_through_no_redaction(self):
        red = _FakeRedactor(entities=5)
        args = {"mrn": "MRN: 884512", "name": "John Doe"}
        out = ensure_mcp_args_safe(
            args,
            phi_boundary="in-boundary",
            phi_enabled=True,
            phi_fail_closed=True,
            redactor=red,
        )
        assert out == args
        assert red.calls == []  # never even screened — not an egress

    def test_phi_disabled_is_pass_through(self):
        red = _FakeRedactor(entities=5)
        out = ensure_mcp_args_safe(
            {"x": "MRN: 884512"},
            phi_boundary="external",
            phi_enabled=False,
            phi_fail_closed=True,
            redactor=red,
        )
        assert out == {"x": "MRN: 884512"}
        assert red.calls == []

    def test_external_clean_args_pass_through(self):
        red = _FakeRedactor(entities=0)
        out = ensure_mcp_args_safe(
            {"codes": ["I10", "E11.9"]},
            phi_boundary="external",
            phi_enabled=True,
            phi_fail_closed=True,
            redactor=red,
        )
        assert out == {"codes": ["I10", "E11.9"]}
        assert len(red.calls) == 1  # screened once

    def test_external_phi_bearing_args_block_fail_closed(self):
        red = _FakeRedactor(entities=2)
        with pytest.raises(PhiEgressBlocked) as ei:
            ensure_mcp_args_safe(
                {"note": "John Doe MRN: 884512"},
                phi_boundary="external",
                phi_enabled=True,
                phi_fail_closed=True,
                server="mcp:term",
                redactor=red,
            )
        assert ei.value.provider == "mcp:term"
        assert "PHI detected" in ei.value.reason

    def test_external_analyzer_failure_blocks_fail_closed(self):
        # Presidio extra missing / analyzer raises ⇒ fail CLOSED (no silent egress).
        red = _FakeRedactor(raises=True)
        with pytest.raises(PhiEgressBlocked):
            ensure_mcp_args_safe(
                {"note": "anything"},
                phi_boundary="external",
                phi_enabled=True,
                phi_fail_closed=True,
                redactor=red,
            )

    def test_external_phi_degrades_open_when_not_fail_closed(self):
        # Explicit per-tenant opt-out (phi_fail_closed=False) ⇒ degrade OPEN.
        red = _FakeRedactor(entities=3)
        args = {"note": "John Doe"}
        out = ensure_mcp_args_safe(
            args,
            phi_boundary="external",
            phi_enabled=True,
            phi_fail_closed=False,
            redactor=red,
        )
        assert out == args


# ---------------------------------------------------------------------------
# McpToolClient — bounded retry + secret-free error normalization
# ---------------------------------------------------------------------------


# `base_url` is now subject to the SSRF egress guard, which fails CLOSED.
# These retry cases therefore have to name an allowed host and a stub resolver; without
# them every call is (correctly) refused before the retry loop is ever reached. The guard
# itself is pinned by `test_egress_guard.py` and `test_mcp_client_egress.py`.
_RETRY_HOST = "mcp.partner.example.com"
_RETRY_URL = f"https://{_RETRY_HOST}/mcp"


def _retry_resolver(hostname: str) -> list[str]:
    return ["203.0.113.10"] if hostname.lower() == _RETRY_HOST else []


class TestMcpToolClientRetry:
    @pytest.mark.asyncio
    async def test_client_error_is_not_retried(self, monkeypatch):
        attempts = {"n": 0}

        async def _once(self, base_url, tool, args, headers):  # noqa: ANN001
            attempts["n"] += 1
            raise McpClientError("bad request", status=400)

        monkeypatch.setattr(McpToolClient, "_call_once", _once)
        client = McpToolClient(
            timeout_s=1.0, max_attempts=3, allowed_hosts=[_RETRY_HOST], resolver=_retry_resolver
        )
        with pytest.raises(McpClientError):
            await client.call_tool(base_url=_RETRY_URL, tool="t", args={})
        assert attempts["n"] == 1  # 4xx never retried

    @pytest.mark.asyncio
    async def test_server_error_retries_then_raises(self, monkeypatch):
        attempts = {"n": 0}

        async def _once(self, base_url, tool, args, headers):  # noqa: ANN001
            attempts["n"] += 1
            raise McpClientError("boom", is_server_error=True, status=503)

        monkeypatch.setattr(McpToolClient, "_call_once", _once)
        client = McpToolClient(
            timeout_s=1.0, max_attempts=2, allowed_hosts=[_RETRY_HOST], resolver=_retry_resolver
        )
        with pytest.raises(McpClientError) as ei:
            await client.call_tool(base_url=_RETRY_URL, tool="t", args={})
        assert attempts["n"] == 2  # bounded retry exhausted
        assert ei.value.is_server_error is True

    @pytest.mark.asyncio
    async def test_success_returns_result(self, monkeypatch):
        async def _once(self, base_url, tool, args, headers):  # noqa: ANN001
            return McpToolResult(content="ok", is_error=False)

        monkeypatch.setattr(McpToolClient, "_call_once", _once)
        client = McpToolClient(
            timeout_s=1.0, max_attempts=2, allowed_hosts=[_RETRY_HOST], resolver=_retry_resolver
        )
        result = await client.call_tool(base_url=_RETRY_URL, tool="t", args={})
        assert result.content == "ok"
        assert result.is_error is False
