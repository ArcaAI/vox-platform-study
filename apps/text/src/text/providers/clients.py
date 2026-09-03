"""The keyed SDK-client cache — B-2, and the isolation property it must not cost.

Every adapter used to build a fresh SDK client on EVERY request, and every one of
them carried a comment explaining why: *"there is no shared client, so two
tenants can never race on one."* That reasoning is correct and it is not
negotiable. A client carries a credential; a client two tenants share is a
credential two tenants share, and on the cloud adapters that is un-invoiced spend
plus a silent cross-tier substitution — the exact failure lane B closed.

But "a new client per request" is a much stronger statement than the isolation
property needs, and at the concurrency this service is being built for it is
expensive: a TLS handshake per stream, and no connection reuse anywhere.

The precise property is:

    two requests may share a client **iff** they would authenticate identically
    to the same endpoint.

So the cache key is exactly that predicate, and nothing else:

    (provider, base_url, credential fingerprint)

## The fingerprint is a salted hash, never the credential

Keying on the credential itself would put every tenant's key in a long-lived
process-wide dict — a credential store nobody designed, reachable from any code
that can reach the cache. Keying on a BARE hash is barely better: an API key has
low enough entropy in places (and a known prefix everywhere) that a bare digest
is a dictionary attack away from the key.

A per-process random salt fixes both. The digest is meaningless outside this
process and unrecoverable inside it, which is all a cache key ever needs to be:
equal for equal credentials, different for different ones.

## Bounded, expiring, evictable

* **Bounded** (LRU) so a tenant churn cannot grow the map without limit.
* **Expiring** so a client for a connection that no longer exists eventually
  goes away even if nothing tells us.
* **Evictable** on `arca:config:invalidate`, which is the real propagation path
  (rule 09 "Config caches": invalidation propagates, the TTL is a
  bounded-staleness net). A rotated credential already produces a NEW key and so
  can never be served from the old entry — eviction is about not leaving a client
  authenticated with a revoked key holding warm sockets.

Eviction DROPS the reference; it does not close the client. A request may still
be streaming through it, and closing a live pool would abort a generation. The
sockets close when the last reference goes.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeVar

import structlog

from text.core.effective_config import register_invalidation_hook

logger = structlog.get_logger(__name__)

_T = TypeVar("_T")

#: Per-process salt. Regenerated on every start, so a fingerprint is meaningless
#: to anything outside this process — including a heap dump taken later.
_CACHE_KEY_SALT = secrets.token_bytes(32)

#: The key a connection with NO credential gets. A keyless self-hosted row (LM
#: Studio, vLLM, Ollama behind a topology `base_url`) is a distinct STATE, not a
#: credential, and giving it its own marker keeps it from colliding with a
#: hypothetical empty-string key.
KEYLESS = "keyless"

#: Entries before the least-recently-used one is dropped. A resource-safety
#: bound on process memory, not a tuning knob: it is sized so that every provider
#: a deployment plausibly serves, times the tenants plausibly active at once,
#: fits — and so that nothing can grow without limit if that assumption is wrong.
CLIENT_CACHE_MAX_ENTRIES = 256

#: Seconds an unused entry is kept. Bounds how long a client for a connection
#: that has since been deleted can linger when no invalidation arrives. Long
#: enough that a normally-busy tenant never pays a rebuild.
CLIENT_CACHE_TTL_S = 900.0


def credential_fingerprint(secret: str, *, salt: bytes | None = None) -> str:
    """A stable, salted, non-reversible stand-in for one credential.

    `hmac` rather than a bare `sha256(salt + secret)`: it is the construction
    designed for keyed digests, and it is constant-time to compare.
    """
    if not secret:
        return KEYLESS
    return hmac.new(salt or _CACHE_KEY_SALT, secret.encode("utf-8"), hashlib.sha256).hexdigest()


@dataclass(frozen=True)
class ClientKey:
    """The identity of an egress client: who we are, and where we are going.

    `credential` is ALWAYS a fingerprint or `KEYLESS` — a raw secret must never
    reach this type. `client_key` is the only sanctioned way to build one.
    """

    provider: str
    base_url: str
    credential: str


def client_key(provider: str, base_url: str | None, secret: str | None) -> ClientKey:
    """Build the cache key for one resolved connection."""
    return ClientKey(
        provider=provider,
        base_url=(base_url or "").strip(),
        credential=credential_fingerprint(secret or ""),
    )


class ClientCache:
    """A bounded, expiring, thread-safe LRU of built SDK clients."""

    def __init__(
        self,
        *,
        max_entries: int = CLIENT_CACHE_MAX_ENTRIES,
        ttl_s: float = CLIENT_CACHE_TTL_S,
        time_func: Callable[[], float] | None = None,
    ) -> None:
        self._max_entries = max_entries
        self._ttl_s = ttl_s
        # Monotonic so a wall-clock step can neither expire nor freeze the cache.
        self._time = time_func or time.monotonic
        self._lock = threading.RLock()
        self._entries: OrderedDict[ClientKey, tuple[float, object]] = OrderedDict()

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def get_or_create(self, key: ClientKey, factory: Callable[[], _T]) -> _T:
        """The client for `key`, building it once if it is absent or expired.

        A factory that RAISES is not cached. A malformed credential must fail
        every time rather than once, and a later good build must not be skipped
        because an earlier one blew up. The build runs outside the lock, so a slow
        construction never blocks another provider's lookup; the double-check on
        re-entry keeps the "same credential, same client" guarantee under a race.
        """
        now = self._time()
        with self._lock:
            hit = self._entries.get(key)
            if hit is not None and now - hit[0] <= self._ttl_s:
                self._entries.move_to_end(key)
                return hit[1]  # type: ignore[return-value]
            if hit is not None:
                del self._entries[key]

        client = factory()

        with self._lock:
            existing = self._entries.get(key)
            if existing is not None and self._time() - existing[0] <= self._ttl_s:
                # A concurrent caller won the race. Return THEIR client so the
                # "same credential, one client" property holds even under
                # contention; ours is dropped unused.
                self._entries.move_to_end(key)
                return existing[1]  # type: ignore[return-value]
            self._entries[key] = (self._time(), client)
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)
        return client

    def evict_provider(self, provider: str) -> int:
        """Drop every entry for one upstream. Returns how many went."""
        with self._lock:
            doomed = [key for key in self._entries if key.provider == provider]
            for key in doomed:
                del self._entries[key]
        return len(doomed)

    def evict_all(self, reason: str = "") -> int:
        """Drop everything. Returns how many entries went."""
        with self._lock:
            dropped = len(self._entries)
            self._entries.clear()
        if dropped:
            logger.info("text.client_cache.evicted", entries=dropped, reason=reason)
        return dropped


#: The process-wide cache. Process-level rather than per-adapter on purpose:
#: `ProviderRegistry` memoizes one adapter instance today, but connection reuse
#: must not silently depend on that staying true.
CLIENT_CACHE = ClientCache()


def evict_all_clients(reason: str = "") -> int:
    """Drop every cached client — the `arca:config:invalidate` entry point."""
    return CLIENT_CACHE.evict_all(reason)


def _on_config_invalidated() -> None:
    evict_all_clients("config-invalidated")


# Registered at import, which is before any client can be built: every adapter
# imports this module to construct one. The hook is what makes a credential
# rotation take effect IMMEDIATELY rather than at the next TTL expiry.
register_invalidation_hook(_on_config_invalidated)
