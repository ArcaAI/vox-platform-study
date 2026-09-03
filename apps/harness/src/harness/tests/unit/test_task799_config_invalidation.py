"""RC-6 — a control-plane write reaches harness without waiting for the TTL.

Before this, propagation to every Python service was TTL-ONLY: the single
Python-facing channel (``arca:guardrail-config:invalidate``) had a subscriber and
zero publishers, and this service had no listener at all. Rule 09
*"Invalidation is the propagation path; TTL is a
bounded-staleness safety net."*

Two things are pinned here, and they are the whole of this service's half of the
contract:

1. the channel literal AGREES with the gateway's publisher — asserted against the
   TypeScript source, because a silently drifting literal is exactly what
   produces a dead listener;
2. one message evicts the snapshot, so the next read refetches — **with no clock
   advanced anywhere in this file**, which is what makes it a proof of PUSH
   rather than of TTL expiry.

The end-to-end pubsub path, the failure postures and the TTL backstop are pinned
once, in ``apps/guardrail/src/guardrail/tests/test_task799_config_invalidation.py``
(the six clients are the same code by design). No live Redis is involved
anywhere: the delivery of the message by redis-py is NOT what these tests prove.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from harness.core.effective_config import (
    CONFIG_INVALIDATION_CHANNEL,
    EffectiveConfigClient,
)


def _repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "pnpm-workspace.yaml").exists():
            return parent
    raise AssertionError("repo root not found from this test file")


class _CountingTransport(httpx.AsyncBaseTransport):
    """Counts fetches, so a refetch is observable without touching the clock."""

    def __init__(self) -> None:
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        return httpx.Response(
            200, json={"service": "harness", "generatedAt": "2026-08-23T00:00:00Z"}
        )


def test_channel_literal_matches_the_gateway_publisher() -> None:
    source = (
        _repo_root()
        / "packages/applications/src/services/settings-registry"
        / "settings-registry-write.service.ts"
    ).read_text()

    assert f"PYTHON_CONFIG_INVALIDATION_CHANNEL = '{CONFIG_INVALIDATION_CHANNEL}'" in source


@pytest.mark.asyncio
async def test_a_published_write_evicts_without_a_ttl_wait() -> None:
    transport = _CountingTransport()
    # A deliberately ENORMOUS TTL: nothing here may converge by expiry.
    client = EffectiveConfigClient("http://gateway/api/v1", "t", ttl_s=86_400, transport=transport)

    await client.get()
    await client.get()
    assert transport.calls == 1, "same window — only an invalidation may force a refetch"

    # The exact bytes the gateway publishes.
    message = json.dumps(
        {
            "key": "retention.ttlSeconds",
            "scope": "system",
            "tenantId": "00000000-0000-0000-0000-000000000000",
        }
    )
    assert client.handle_invalidation_message(message) is True

    await client.get()
    assert transport.calls == 2, "the write must be observed without a TTL wait"
