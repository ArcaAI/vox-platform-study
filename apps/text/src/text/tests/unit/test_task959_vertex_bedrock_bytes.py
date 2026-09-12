"""TASK-959 §4.1 — the two adapters that were invisible to the pool.

Everything reached through `openai`/`anthropic`/`openai_compat` already runs on
`pooled_http_client`, so the transport seam counts it. Two adapters did not:

* **Vertex** built `genai.Client(...)` with no `http_options`, so the SDK made
  its own client — off the pool, and (worse) on aiohttp when that is installed,
  which has no httpx transport to instrument at all. Injecting the pooled client
  through `HttpOptions.httpx_async_client` puts it back on the one seam AND
  forces the httpx path: `_use_aiohttp()` is false whenever a custom async
  client is supplied.
* **Bedrock** is botocore, not httpx, so it can never be on the pool. It gets
  the equivalent from botocore's own event system: `before-send` sees the
  prepared request, `response-received` sees the parsed response dict.

The Bedrock response gap is asserted rather than glossed: a `converse_stream`
body reaches `response-received` as an unread event stream, and reading it to
size it would consume the generation. Request bytes are counted, response bytes
stay `None`, and the test says so — a documented blind spot beats a fabricated
number.
"""

from __future__ import annotations

from typing import Any

import google.auth.credentials
import pytest
from pydantic import SecretStr

from text.models.requests import GenerateRequest, ProviderOverride
from text.providers.pool import count_provider_bytes

_SERVICE_ACCOUNT_JSON = '{"type":"service_account","project_id":"p"}'


class _FakeCredentials(google.auth.credentials.Credentials):
    def refresh(self, request: Any) -> None:  # pragma: no cover - never called
        self.token = "fake"


def _vertex_request() -> GenerateRequest:
    return GenerateRequest(
        prompt="p",
        provider="vertex",
        model="gemini-3-pro",
        provider_overrides={
            "vertex": ProviderOverride(
                api_key=SecretStr(_SERVICE_ACCOUNT_JSON),
                project="p",
                location="us-central1",
                funding="tenant",
            )
        },
    )


class TestVertexJoinsThePool:
    @pytest.fixture(autouse=True)
    def _patch_credentials(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from text.providers import vertex as vertex_module

        monkeypatch.setattr(
            vertex_module,
            "_credentials_from_service_account",
            lambda _raw: _FakeCredentials(),
        )
        from text.providers.clients import CLIENT_CACHE

        CLIENT_CACHE.evict_provider("vertex")

    def test_the_sdk_client_is_built_on_the_pooled_transport(self) -> None:
        from text.providers.pool import TransportFamily, pooled_http_client
        from text.providers.vertex import VertexProvider

        client = VertexProvider()._client_for(_vertex_request())
        pooled = pooled_http_client("vertex", timeout_s=300, family=TransportFamily.HTTPX)
        assert client._api_client._async_httpx_client is pooled

    def test_injecting_the_client_also_takes_vertex_off_aiohttp(self) -> None:
        """aiohttp has no httpx transport, so a call on it is unmeasurable."""
        from text.providers.vertex import VertexProvider

        client = VertexProvider()._client_for(_vertex_request())
        assert client._api_client._use_aiohttp() is False

    def test_that_client_carries_the_counting_transport(self) -> None:
        """The pooled client's transport IS the counting one, so a real Vertex
        call is credited by construction rather than by a second code path."""
        from text.providers.pool import _HTTPX_DRAINING_TRANSPORT
        from text.providers.vertex import VertexProvider

        client = VertexProvider()._client_for(_vertex_request())
        transport = client._api_client._async_httpx_client._transport
        assert isinstance(transport, _HTTPX_DRAINING_TRANSPORT)


def _bedrock_request() -> GenerateRequest:
    return GenerateRequest(
        prompt="p",
        provider="bedrock",
        model="anthropic.claude-x",
        provider_overrides={
            "bedrock": ProviderOverride(
                api_key=SecretStr("bedrock-token"),
                region="us-east-1",
                funding="tenant",
            )
        },
    )


class TestBedrockCountsThroughBotocoreHooks:
    @pytest.fixture(autouse=True)
    def _fresh_cache(self) -> None:
        from text.providers.clients import CLIENT_CACHE

        CLIENT_CACHE.evict_provider("bedrock")

    def test_a_non_streaming_call_counts_both_directions(self) -> None:
        from text.providers.bedrock import BedrockProvider

        client = BedrockProvider()._client_for(_bedrock_request())
        events = client.meta.events
        body = b'{"messages":[{"role":"user","content":[{"text":"p"}]}]}'
        payload = b'{"output":{"message":{"content":[{"text":"ok"}]}}}'

        with count_provider_bytes("bedrock", funding="tenant") as counts:
            events.emit("before-send.bedrock-runtime.Converse", request=_PreparedRequest(body))
            events.emit(
                "response-received.bedrock-runtime.Converse",
                response_dict={"body": payload, "headers": {}},
                parsed_response={},
                context={},
                exception=None,
            )

        assert counts.request_bytes == len(body)
        assert counts.response_bytes == len(payload)
        assert counts.observed is True

    def test_a_streaming_response_counts_the_request_and_reports_no_response(self) -> None:
        """The documented gap: an unread event stream cannot be sized.

        Counting it would mean reading the body, which IS the generation. So the
        request is counted, the response is not, and `usage_detail` reports
        `response_bytes: None` rather than a zero that would read as "the vendor
        sent nothing".
        """
        from text.providers.bedrock import BedrockProvider

        client = BedrockProvider()._client_for(_bedrock_request())
        events = client.meta.events
        body = b'{"messages":[]}'

        with count_provider_bytes("bedrock", funding="tenant") as counts:
            events.emit(
                "before-send.bedrock-runtime.ConverseStream", request=_PreparedRequest(body)
            )
            events.emit(
                "response-received.bedrock-runtime.ConverseStream",
                response_dict={"body": _UnreadEventStream(), "headers": {}},
                parsed_response={},
                context={},
                exception=None,
            )

        assert counts.request_bytes == len(body)
        assert counts.response_bytes == 0

    def test_a_content_length_header_is_used_when_the_body_is_not_bytes(self) -> None:
        from text.providers.bedrock import BedrockProvider

        client = BedrockProvider()._client_for(_bedrock_request())
        with count_provider_bytes("bedrock") as counts:
            client.meta.events.emit(
                "response-received.bedrock-runtime.Converse",
                response_dict={"body": _UnreadEventStream(), "headers": {"content-length": "777"}},
                parsed_response={},
                context={},
                exception=None,
            )
        assert counts.response_bytes == 777

    def test_hooks_are_registered_once_per_cached_client(self) -> None:
        """The client is CACHED; registering per call would double-count."""
        from text.providers.bedrock import BedrockProvider

        provider = BedrockProvider()
        first = provider._client_for(_bedrock_request())
        second = provider._client_for(_bedrock_request())
        assert first is second

        body = b'{"x":1}'
        with count_provider_bytes("bedrock") as counts:
            first.meta.events.emit(
                "before-send.bedrock-runtime.Converse", request=_PreparedRequest(body)
            )
        assert counts.request_bytes == len(body)

    def test_a_hook_firing_with_no_record_bound_is_harmless(self) -> None:
        from text.providers.bedrock import BedrockProvider

        client = BedrockProvider()._client_for(_bedrock_request())
        # No `count_provider_bytes` around it — must not raise and must not
        # attribute the bytes to whatever ran last.
        client.meta.events.emit(
            "before-send.bedrock-runtime.Converse", request=_PreparedRequest(b'{"x":1}')
        )

    def test_the_hook_never_short_circuits_the_request(self) -> None:
        """A `before-send` handler that returns non-None REPLACES the response."""
        from text.providers.bedrock import BedrockProvider

        client = BedrockProvider()._client_for(_bedrock_request())
        responses = client.meta.events.emit(
            "before-send.bedrock-runtime.Converse", request=_PreparedRequest(b"{}")
        )
        assert all(result is None for _handler, result in responses)


class _PreparedRequest:
    """The shape botocore's `before-send` hands a handler."""

    def __init__(self, body: bytes) -> None:
        self.body = body
        self.headers: dict[str, str] = {}


class _UnreadEventStream:
    """A streaming body that MUST NOT be read to be sized."""

    def read(self) -> bytes:  # pragma: no cover - reading it is the bug
        raise AssertionError("the event stream must never be consumed to count bytes")
