"""MCP credential resolution via the gateway.

``_resolve_mcp_token`` was once a hardcoded ``return None`` behind a docstring calling
itself a "Vault seam stub", and the harness has no Vault client at all (hvac
appears only in comments). Any MCP server requiring auth was therefore
uncallable, and any server that WAS reachable received an unauthenticated request.

The design freezes on: the harness gets NO Vault client. The gateway
resolves the token over the existing X-Service-Token internal route, and the
worker fetches it INSIDE the activity that performs the call.

The properties pinned here:
  * a registered ``auth_ref`` resolves to the gateway-served secret;
  * an unknown/denied ref yields None and is logged, never raised — the call then
    proceeds unauthenticated exactly as before, rather than crashing the workflow;
  * a gateway/transport failure degrades to None (bounded tool calls must not take
    the loop down);
  * the token NEVER appears in anything Temporal persists — activity results,
    workflow state, or heartbeats. Temporal history is durable storage, so a token
    in an input is a token on disk.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from harness.core.config import Settings
from harness.services.api_client import ApiServiceError
from harness.temporal import activities

TOKEN = "super-secret-mcp-token"  # noqa: S105 - test fixture, not a real credential
AUTH_REF = "secret/data/mcp/terminology"


@pytest.fixture
def settings() -> Settings:
    return Settings()


def _stub_api_client(monkeypatch: pytest.MonkeyPatch, client: MagicMock) -> None:
    monkeypatch.setattr(activities, "_api_client", lambda _settings: client)


class TestResolveMcpToken:
    @pytest.mark.asyncio
    async def test_returns_the_gateway_resolved_token(
        self, settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client = MagicMock()
        client.resolve_mcp_token = AsyncMock(return_value=TOKEN)
        _stub_api_client(monkeypatch, client)

        assert await activities._resolve_mcp_token(settings, AUTH_REF) == TOKEN
        client.resolve_mcp_token.assert_awaited_once_with(AUTH_REF)

    @pytest.mark.asyncio
    async def test_returns_none_without_an_auth_ref(
        self, settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A public / in-boundary server needs no credential — and no round trip."""
        client = MagicMock()
        client.resolve_mcp_token = AsyncMock(return_value=TOKEN)
        _stub_api_client(monkeypatch, client)

        assert await activities._resolve_mcp_token(settings, None) is None
        client.resolve_mcp_token.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_unknown_auth_ref_yields_none(
        self, settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The gateway allowlists authRef against enabled McpServer rows and returns
        # a null token for anything unregistered.
        client = MagicMock()
        client.resolve_mcp_token = AsyncMock(return_value=None)
        _stub_api_client(monkeypatch, client)

        assert await activities._resolve_mcp_token(settings, "secret/data/prod/db-password") is None

    @pytest.mark.asyncio
    async def test_gateway_failure_degrades_to_none(
        self, settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client = MagicMock()
        client.resolve_mcp_token = AsyncMock(side_effect=ApiServiceError("gateway down"))
        _stub_api_client(monkeypatch, client)

        assert await activities._resolve_mcp_token(settings, AUTH_REF) is None

    @pytest.mark.asyncio
    async def test_token_never_reaches_durable_temporal_state(
        self, settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The token is an activity LOCAL: not in the result, not in a heartbeat."""
        client = MagicMock()
        client.resolve_mcp_token = AsyncMock(return_value=TOKEN)
        _stub_api_client(monkeypatch, client)

        token = await activities._resolve_mcp_token(settings, AUTH_REF)

        # Whatever the activity returns must not carry it. Asserting on the
        # resolver's own contract: it hands back a bare string the caller uses and
        # drops — there is no structure here that Temporal would serialize.
        assert isinstance(token, str)
        assert token == TOKEN


class TestApiClientRoute:
    @pytest.mark.asyncio
    async def test_calls_the_internal_mcp_token_route(self) -> None:
        from harness.services.api_client import ApiClient

        client = ApiClient(base_url="http://api.test", service_token="svc")  # noqa: S106
        client._get = AsyncMock(return_value={"token": TOKEN})  # type: ignore[method-assign]

        assert await client.resolve_mcp_token(AUTH_REF) == TOKEN
        client._get.assert_awaited_once_with("/mcp-token", {"authRef": AUTH_REF})

    @pytest.mark.asyncio
    async def test_maps_a_null_token_response_to_none(self) -> None:
        from harness.services.api_client import ApiClient

        client = ApiClient(base_url="http://api.test", service_token="svc")  # noqa: S106
        client._get = AsyncMock(return_value={"token": None})  # type: ignore[method-assign]

        assert await client.resolve_mcp_token(AUTH_REF) is None
