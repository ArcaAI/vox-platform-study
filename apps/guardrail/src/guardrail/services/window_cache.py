"""The window-verdict cache (TASK-1047 D5 / FC-7) — content-addressed, PHI-safe.

A screen verdict is a deterministic function of (policy, model, task, window text),
so a window already screened is never screened again: the live-summary lane
re-sends the whole transcript-so-far on every flush, and only its tail is new.

**Key** — frozen cross-lane contract FC-7, implemented exactly::

    gr:wv:<task>:<hmac>
    hmac = HMAC-SHA256(K_t, policyVersion ‖ 0x1f ‖ modelId ‖ 0x1f ‖ task ‖ 0x1f ‖ windowText)
    K_t  = HMAC-SHA256(GUARDRAIL_WINDOW_CACHE_KEY, tenantId)

The key is an HMAC, never a plain hash: an attacker holding Redis cannot confirm a
guessed transcript by hashing it. `K_t` is per tenant, so one tenant's verdict is
unreachable from another's request even for byte-identical text, and the policy
version + model id make every policy or model change a COLD cache rather than a
stale answer.

**Value** — verdict fields only (labels, offsets, scores). NEVER text: not the
window, not a matched fragment, not model prose (which may quote the window).

**Posture.** The secret is a platform `vault-kv` secret. ABSENT ⇒ the cache does
not exist and every window is computed — never skipped. A Redis error on read is a
MISS and on write is ignored: the cache may cost latency, never a verdict.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, Final

from guardrail.core.logging import get_logger

logger = get_logger(__name__)

CACHE_KEY_PREFIX: Final = "gr:wv"
_SEP: Final = "\x1f"


def _tenant_key(secret: str, tenant_id: str) -> bytes:
    return hmac.new(secret.encode("utf-8"), tenant_id.encode("utf-8"), hashlib.sha256).digest()


def window_cache_key(
    secret: str,
    tenant_id: str,
    policy_version: str,
    model_id: str,
    task: str,
    window_text: str,
) -> str:
    """The FC-7 Redis key for one window's verdict. Carries no text."""
    message = _SEP.join((policy_version, model_id, task, window_text)).encode("utf-8")
    digest = hmac.new(_tenant_key(secret, tenant_id), message, hashlib.sha256).hexdigest()
    return f"{CACHE_KEY_PREFIX}:{task}:{digest}"


class WindowVerdictCache:
    """Redis-backed verdict store. Construct through :meth:`build`."""

    def __init__(self, redis: Any, secret: str, ttl_s: int) -> None:
        self._redis = redis
        self._secret = secret
        self._ttl_s = max(1, int(ttl_s))

    @classmethod
    def build(cls, redis: Any, secret: str | None, *, ttl_s: int) -> WindowVerdictCache | None:
        """The cache, or ``None`` when there is no secret or no store (cache disabled)."""
        if redis is None or not (secret or "").strip():
            return None
        return cls(redis, str(secret), ttl_s)

    def key(
        self, tenant_id: str, policy_version: str, model_id: str, task: str, window_text: str
    ) -> str:
        return window_cache_key(
            self._secret, tenant_id, policy_version, model_id, task, window_text
        )

    async def get(self, key: str) -> dict[str, Any] | None:
        """A cached verdict, or ``None`` — a Redis error or a corrupt value is a miss."""
        try:
            raw = await self._redis.get(key)
        except Exception as exc:  # noqa: BLE001 — a cache read never decides a verdict
            logger.warning("guardrail.window_cache.read_failed", error_type=type(exc).__name__)
            return None
        if raw is None:
            return None
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            return None
        return value if isinstance(value, dict) else None

    async def set(self, key: str, value: dict[str, Any]) -> None:
        """Store a verdict (text-free by contract). A Redis error is logged and ignored."""
        try:
            await self._redis.set(key, json.dumps(value, separators=(",", ":")), ex=self._ttl_s)
        except Exception as exc:  # noqa: BLE001 — a cache write never decides a verdict
            logger.warning("guardrail.window_cache.write_failed", error_type=type(exc).__name__)
