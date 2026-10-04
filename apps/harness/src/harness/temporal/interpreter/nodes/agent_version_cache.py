"""TASK-1038 D-A / R-6 — the in-process cache of PINNED agent-version resolutions.

An agent VERSION row is immutable once published, so the gateway's answer for
``(tenantId, slug, versionNumber)`` does not change for the parts that define the agent — its
model chain, instruction, frozen prompt, parameters and schemas. Caching it removes one gateway
round trip per pinned ``core.agent`` node per run.

Three properties keep that safe:

* **Keyed by tenant.** The key is ``(tenantId, slug, versionNumber)``; one tenant's answer is
  never served to another (09-infrastructure-devops §Config caches, rule 1).
* **No credential is ever cached.** A resolve answer may carry a resolved BYO connection
  (``providerOverride`` on the agent or on a ``textPrimary`` / ``textFallback`` candidate). Those
  are rotated independently of the version, and holding one in memory past its rotation would
  spend a revoked key. An answer carrying one anywhere is returned but never stored.
* **Nothing resolved PER CALL is ever cached** (TASK-1038 lane E3, owner rule W3 / OD-22). The
  version pins the agent; it does not pin its document template. The gateway resolves the
  answer's ``documentTemplate`` member to the LATEST approved template version on every call, so
  a republished template must reach the very next run. An answer carrying a member listed in
  :data:`PER_CALL_MEMBERS` is returned but never stored — the template is then resolved fresh by
  the gateway on every call, exactly as for an unpinned node. (Stripping the member and serving
  the rest from cache would need a second, template-only gateway round trip per call, which
  saves nothing over not caching.)
* **Bounded, with a staleness ceiling.** At most :data:`MAX_ENTRIES` entries (least recently used
  evicted first), each kept for at most :data:`TTL_SECONDS`. The version is immutable but the
  answer also carries gateway-DERIVED facts (registry rows of the models it names, the SYSTEM tail
  of the fallback chain) that a platform admin can change; the TTL bounds how long a worker can
  serve such a fact after it changed. Both are cache-sizing implementation constants, not product
  configuration.

Process-local and activity-side only — never imported by workflow code.
"""

from __future__ import annotations

import copy
import time
from collections import OrderedDict
from typing import Any

#: Most entries held at once (least recently used evicted first).
MAX_ENTRIES = 256
#: How long one entry is served before the gateway is asked again.
TTL_SECONDS = 300.0

#: Top-level members of a resolve answer the gateway resolves PER CALL (they float while the
#: version is pinned). An answer carrying any of them is never cached.
PER_CALL_MEMBERS: tuple[str, ...] = ("documentTemplate",)

_Key = tuple[str, str, int]
_ENTRIES: OrderedDict[_Key, tuple[float, dict[str, Any]]] = OrderedDict()


def carries_credential(value: Any) -> bool:
    """Whether a resolve answer holds a resolved connection anywhere in it (deep, pure)."""
    if isinstance(value, dict):
        override = value.get("providerOverride")
        if override:
            return True
        return any(carries_credential(v) for v in value.values())
    if isinstance(value, list):
        return any(carries_credential(v) for v in value)
    return False


def get(tenant_id: str, slug: str, version_number: int) -> dict[str, Any] | None:
    key = (tenant_id, slug, version_number)
    entry = _ENTRIES.get(key)
    if entry is None:
        return None
    stored_at, answer = entry
    if time.monotonic() - stored_at > TTL_SECONDS:
        _ENTRIES.pop(key, None)
        return None
    _ENTRIES.move_to_end(key)
    # A copy each way: a caller that mutates its answer must never edit the cached one.
    return copy.deepcopy(answer)


def carries_per_call_member(answer: dict[str, Any]) -> bool:
    """Whether a resolve answer holds a member resolved per call (pure)."""
    return any(answer.get(member) is not None for member in PER_CALL_MEMBERS)


def put(tenant_id: str, slug: str, version_number: int, answer: dict[str, Any]) -> None:
    if carries_credential(answer) or carries_per_call_member(answer):
        return
    key = (tenant_id, slug, version_number)
    _ENTRIES[key] = (time.monotonic(), copy.deepcopy(answer))
    _ENTRIES.move_to_end(key)
    while len(_ENTRIES) > MAX_ENTRIES:
        _ENTRIES.popitem(last=False)


def size() -> int:
    return len(_ENTRIES)


def clear() -> None:
    _ENTRIES.clear()
