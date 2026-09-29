"""``outbound_context_headers`` — what a peer client merges into its headers."""

from __future__ import annotations

from hope_obs import bind_request_context, outbound_context_headers


def test_carries_bound_request_id() -> None:
    bind_request_context(requestId="rid-7", tenantId="t-1")
    assert outbound_context_headers() == {"X-Request-Id": "rid-7"}


def test_empty_when_nothing_bound() -> None:
    assert outbound_context_headers() == {}
