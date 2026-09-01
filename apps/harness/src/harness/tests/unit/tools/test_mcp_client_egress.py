"""TASK-846 D-3 — the CALL-time SSRF guard on the MCP tool client.

Two layers are pinned here.

1. :class:`McpToolClient` refuses a disallowed ``base_url`` BEFORE any transport work —
   no lazy SDK import, no socket, no retry. This layer is fully hermetic.

2. :class:`PinnedEgressTransport` re-validates and PINS every single request that leaves
   the client, which is what closes DNS rebinding and what makes a redirect hop
   (or any subsequent streamable-HTTP session request) subject to the same rule as the
   first one. That layer needs ``httpx2``, which ships only with the optional
   ``mcp-tools`` extra, so those tests skip when the extra is absent. The RULE they
   exercise is covered unconditionally by ``test_egress_guard.py``; what skips is the
   wiring, not the policy.
"""

from __future__ import annotations

import pytest

from harness.tools.egress_guard import EgressBlocked, evaluate_egress
from harness.tools.mcp_client import McpToolClient, McpToolResult

ALLOWED = ["mcp.partner.example.com"]
ALLOWED_URL = "https://mcp.partner.example.com/mcp"
METADATA_URL = "http://169.254.169.254/latest/meta-data/"


def _resolver(hostname: str) -> list[str]:
    return {"mcp.partner.example.com": ["203.0.113.10"], "evil.example.com": ["10.0.0.5"]}.get(
        hostname.lower(), []
    )


def _client(**kw) -> McpToolClient:
    kw.setdefault("allowed_hosts", ALLOWED)
    kw.setdefault("resolver", _resolver)
    return McpToolClient(timeout_s=1.0, max_attempts=3, **kw)


class TestCallToolEgressPreCheck:
    @pytest.mark.asyncio
    async def test_blocked_url_never_reaches_the_transport(self, monkeypatch):
        """The guard runs BEFORE `_call_once` — nothing is dialled, nothing is imported."""
        calls = {"n": 0}

        async def _once(self, *a, **k):  # noqa: ANN001
            calls["n"] += 1
            return McpToolResult(content="ok")

        monkeypatch.setattr(McpToolClient, "_call_once", _once)
        with pytest.raises(EgressBlocked):
            await _client(allowed_hosts=["169.254.169.254"]).call_tool(
                base_url=METADATA_URL, tool="t", args={}
            )
        assert calls["n"] == 0

    @pytest.mark.asyncio
    async def test_egress_denial_is_not_retried(self, monkeypatch):
        """A policy refusal is not a transient fault — retrying it is pure noise."""
        calls = {"n": 0}

        async def _once(self, *a, **k):  # noqa: ANN001
            calls["n"] += 1
            return McpToolResult(content="ok")

        monkeypatch.setattr(McpToolClient, "_call_once", _once)
        with pytest.raises(EgressBlocked) as ei:
            await _client(allowed_hosts=["evil.example.com"]).call_tool(
                base_url="https://evil.example.com/mcp", tool="t", args={}
            )
        assert calls["n"] == 0
        assert ei.value.reason == "blocked_address"

    @pytest.mark.asyncio
    async def test_absent_allowlist_fails_closed(self, monkeypatch):
        """`None` is how the control plane reports 'unresolved'. It must deny."""
        monkeypatch.setattr(McpToolClient, "_call_once", lambda *a, **k: None)
        with pytest.raises(EgressBlocked) as ei:
            await McpToolClient(allowed_hosts=None, resolver=_resolver).call_tool(
                base_url=ALLOWED_URL, tool="t", args={}
            )
        assert ei.value.reason == "allowlist_unavailable"

    @pytest.mark.asyncio
    async def test_allowed_url_proceeds(self, monkeypatch):
        async def _once(self, *a, **k):  # noqa: ANN001
            return McpToolResult(content="ok", is_error=False)

        monkeypatch.setattr(McpToolClient, "_call_once", _once)
        result = await _client().call_tool(base_url=ALLOWED_URL, tool="t", args={})
        assert result.content == "ok"


class TestRedirectTargetIsRevalidated:
    """A 302 to the metadata endpoint must not be reachable.

    The client sets ``follow_redirects=False``, so a redirect is never followed at all.
    This asserts the second, independent layer: were a hop ever taken, the SAME guard
    that vetted the original URL vets the new target and denies it.
    """

    def test_redirect_location_to_metadata_is_denied(self):
        decision = evaluate_egress(METADATA_URL, ALLOWED, _resolver)
        assert decision.allowed is False
        assert decision.reason == "host_not_allowed"

    def test_redirect_location_to_allowlisted_name_pointing_inside_is_denied(self):
        # The nastier version: the redirect target IS allow-listed, but resolves private.
        decision = evaluate_egress("https://evil.example.com/mcp", ["evil.example.com"], _resolver)
        assert decision.allowed is False
        assert decision.reason == "blocked_address"


# ── The httpx2 transport wiring (skips without the optional `mcp-tools` extra) ──


@pytest.fixture()
def httpx2_mod():
    return pytest.importorskip("httpx2", reason="ships with the optional `mcp-tools` extra")


class TestPinnedEgressTransport:
    @pytest.mark.asyncio
    async def test_connects_to_the_validated_ip_and_preserves_the_host_header(self, httpx2_mod):
        """THE anti-rebinding property: the socket goes to the address we checked.

        Re-resolving after validating is the classic TOCTOU — the attacker answers the
        first lookup with a public address and the second with 169.254.169.254.
        """
        from harness.tools.egress_transport import PinnedEgressTransport

        seen: dict = {}

        def _handler(request):
            seen["url"] = str(request.url)
            seen["host_header"] = request.headers.get("Host")
            seen["sni"] = request.extensions.get("sni_hostname")
            return httpx2_mod.Response(200, content=b"ok")

        transport = PinnedEgressTransport(
            httpx2_mod.MockTransport(_handler),
            allowed_hosts=ALLOWED,
            resolver=_resolver,
            max_response_bytes=1024,
        )
        async with httpx2_mod.AsyncClient(transport=transport) as client:
            response = await client.get(ALLOWED_URL)

        assert response.status_code == 200
        # Dialled the pinned literal, not the name.
        assert seen["url"] == "https://203.0.113.10/mcp"
        # …while still presenting the real host for routing and TLS.
        assert seen["host_header"] == "mcp.partner.example.com"
        assert seen["sni"] == "mcp.partner.example.com"

    @pytest.mark.asyncio
    async def test_every_request_is_revalidated_not_just_the_first(self, httpx2_mod):
        from harness.tools.egress_transport import PinnedEgressTransport

        transport = PinnedEgressTransport(
            httpx2_mod.MockTransport(lambda r: httpx2_mod.Response(200, content=b"ok")),
            allowed_hosts=ALLOWED,
            resolver=_resolver,
            max_response_bytes=1024,
        )
        async with httpx2_mod.AsyncClient(transport=transport) as client:
            await client.get(ALLOWED_URL)  # first hop fine
            # A later request on the SAME client to a different target is still checked —
            # this is what covers the streamable-HTTP session's follow-up requests.
            with pytest.raises(EgressBlocked):
                await client.get(METADATA_URL)

    @pytest.mark.asyncio
    async def test_oversized_response_is_cut_off(self, httpx2_mod):
        """Bounds the blast radius: a hostile server cannot stream the worker to death."""
        from harness.tools.egress_transport import PinnedEgressTransport, ResponseTooLarge

        transport = PinnedEgressTransport(
            httpx2_mod.MockTransport(lambda r: httpx2_mod.Response(200, content=b"x" * 5000)),
            allowed_hosts=ALLOWED,
            resolver=_resolver,
            max_response_bytes=1024,
        )
        async with httpx2_mod.AsyncClient(transport=transport) as client:
            with pytest.raises(ResponseTooLarge):
                await client.get(ALLOWED_URL)

    @pytest.mark.asyncio
    async def test_response_within_the_cap_passes_through_intact(self, httpx2_mod):
        from harness.tools.egress_transport import PinnedEgressTransport

        transport = PinnedEgressTransport(
            httpx2_mod.MockTransport(lambda r: httpx2_mod.Response(200, content=b"y" * 900)),
            allowed_hosts=ALLOWED,
            resolver=_resolver,
            max_response_bytes=1024,
        )
        async with httpx2_mod.AsyncClient(transport=transport) as client:
            response = await client.get(ALLOWED_URL)
        assert response.content == b"y" * 900
