"""Where a realtime verdict and a session's aggregation state live between calls.

Two consumers read a verdict; three tiers update a session. Neither can be
in-process state, because guardrail runs as several replicas and a verdict that
only one of them can see is a verdict that is recomputed per consumer — which is
the N-times-the-cost, N-inconsistent-verdicts outcome the whole design exists to
avoid.

**Everything stored here is PHI-free by construction.** Verdicts carry labels,
offsets, counts and versions; session state is five numbers plus a short
automaton tail. Redis persistence is disabled on this platform for exactly the
PHI reason, so nothing that could not survive being lost — and nothing that
could leak — is kept here. The durable audit record (EU AI Act Article 12,
six-month retention) is a separate obligation on a durable store, and is NOT
satisfied by this cache.

The one exception worth naming: the resume tail IS a fragment of transcript, up
to (longest declared phrase - 1) characters. It is capped by the longest pattern
rather than by convenience, and callers that consider even that too much can set
the deterministic taxonomy's longest phrase accordingly.
"""

from __future__ import annotations

import json
from typing import Any, Protocol


class RealtimeStore(Protocol):
    """Minimal KV. Key construction lives with the policy that scopes it."""

    async def get(self, key: str) -> dict[str, Any] | None: ...

    async def put(self, key: str, value: dict[str, Any], ttl_s: int) -> None: ...


class InMemoryRealtimeStore:
    """Test/dev double. Same semantics, no TTL enforcement."""

    def __init__(self) -> None:
        self._data: dict[str, dict[str, Any]] = {}

    async def get(self, key: str) -> dict[str, Any] | None:
        return self._data.get(key)

    async def put(self, key: str, value: dict[str, Any], ttl_s: int) -> None:
        self._data[key] = value


class RedisRealtimeStore:
    """The shared store. One JSON blob per key, TTL'd."""

    def __init__(self, redis: Any) -> None:
        self._redis = redis

    async def get(self, key: str) -> dict[str, Any] | None:
        raw = await self._redis.get(key)
        if not raw:
            return None
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            # A corrupt cache entry is a MISS, never a verdict. Recomputing is
            # cheap; interpreting half a verdict is not.
            return None
        return value if isinstance(value, dict) else None

    async def put(self, key: str, value: dict[str, Any], ttl_s: int) -> None:
        await self._redis.set(key, json.dumps(value), ex=max(1, int(ttl_s)))


def session_key(tenant_id: str, session_id: str) -> str:
    """Tenant FIRST and always: a session key without it is a cross-tenant read."""
    return f"gr:rt:sess:{tenant_id}:{session_id}"


def segment_key(tenant_id: str, segment_id: str) -> str:
    """The handle consumers read a verdict by, instead of calling guardrail."""
    return f"gr:rt:seg:{tenant_id}:{segment_id}"
