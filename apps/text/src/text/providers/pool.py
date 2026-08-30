"""Outbound resource pools: one HTTP connection pool per upstream, and the one
bounded thread pool the Bedrock SDK bridge is allowed to use.

Two bottlenecks from the TASK-818 audit meet here, and they are the same bug
wearing different clothes: **a shared resource sized for nobody**.

* **B-8** — every adapter either built its own transport per request or shared
  ONE process-wide `httpx.AsyncClient`. httpx's defaults
  (`max_connections=100, max_keepalive_connections=20, keepalive_expiry=5.0`)
  are a sensible client library default and a poor egress-proxy default: one
  global pool means a saturated vendor starves a healthy self-hosted engine, and
  a single `keepalive_expiry` cannot be correct for upstreams whose idle timeouts
  differ. So: **one client per upstream** (4.2), each carrying that upstream's
  own limits.
* **B-3** — Bedrock's boto3 stream is a SYNCHRONOUS iterator, bridged onto the
  loop with `run_in_executor(None, ...)`. `None` is asyncio's DEFAULT executor,
  `min(32, cpu + 4)` threads, and the bridge holds its thread for the whole
  stream. Around 32 concurrent Bedrock streams therefore starve every other
  `asyncio.to_thread` caller in the process. The interim fix (4.3) is a
  **dedicated, bounded** pool, so Bedrock's ceiling is Bedrock's own.

## Where the numbers come from

Nothing here is a deployment choice expressed in code. The module-level values
are FLOORS in the exact sense `core/runtime_defaults.py` defines: what keeps one
wedged upstream from exhausting this process during the window before the control
plane has answered. Real operating values arrive from `AiRuntimeProfile` through
`GET /internal/effective-config?service=text` and are applied by
`apply_pool_policy`, which is the same channel — and the same fail-safe posture —
that already moves concurrency, timeouts and vendor quotas.

Consequently `apply_pool_policy` follows the two house invariants:

* a **negative-cached** snapshot (gateway down) changes nothing at all;
* a provider the snapshot does not describe gets the FLOOR, because for a policy
  map rebuilt from the snapshot the floor *is* the "no opinion" state. That
  differs from `apply_provider_limits`, which must not reset a live semaphore
  holding permits — here there is no live state to lose, so the gateway stays
  authoritative in both directions.

## `keepalive_expiry` is the field that bites

4.2, stated plainly: an expiry ABOVE the upstream's idle timeout hands you
sockets the peer has already reaped, which surface as sporadic, unattributable
connection errors under load. The floor is therefore deliberately conservative —
low enough to be safe against every upstream, never the intended operating value.
Raising it is a per-upstream decision, made on the `AiRuntimeProfile` row for
that upstream, by someone who knows that upstream's idle timeout.

## ⚠️ This service runs TWO HTTP client libraries, and they are not interchangeable

`openai>=3` migrated its transport to **`httpx2`**; `anthropic` is still on
**`httpx`**. Both ship a `Limits` / `Timeout` / `http2=` surface with the same
shape, which is exactly what makes the mistake easy: handing an `httpx.AsyncClient`
to `AsyncOpenAI` is accepted at CONSTRUCTION (it is duck-typed) and only misbehaves
later, in the transport, on a real request. mypy is the only thing that catches it,
because `openai._base_client` annotates `http_client: httpx2.AsyncClient | None`.

So a pooled client is built for a declared `TransportFamily` and the two families
are cached separately. Anything reached through the OpenAI SDK — `openai`,
`azure-openai`, and every OpenAI-wire self-hosted engine (LM Studio, vLLM) —
is `HTTPX2`; Anthropic and the adapters that speak httpx directly are `HTTPX`.
"""

from __future__ import annotations

import asyncio
import importlib.util
import threading
from collections.abc import AsyncIterator, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from enum import StrEnum
from typing import TYPE_CHECKING, Any, TypeVar

import httpx

# `httpx2` currently reaches this service TRANSITIVELY, through `openai>=3`. This
# is the first module to import it DIRECTLY, so it should be declared in
# `apps/text/pyproject.toml` (which needs a root `uv lock`, an orchestrator-owned
# surface — raised in this lane's ROOT_CONFIG_REQUESTS rather than done here).
import httpx2
import structlog

from text.core.runtime_defaults import (
    HTTPX_MAX_CONNECTIONS,
    HTTPX_MAX_KEEPALIVE,
    PROVIDER_MAX_CONCURRENT_FLOOR,
)
from text.providers.clients import CLIENT_CACHE, evict_all_clients

if TYPE_CHECKING:
    from text.core.effective_config import EffectiveConfigSnapshot

logger = structlog.get_logger(__name__)

_T = TypeVar("_T")


class TransportFamily(StrEnum):
    """Which HTTP client library an adapter's SDK is built on.

    Declared rather than inferred because the two libraries are structurally
    identical and silently incompatible — see the module docstring. An adapter
    names the family its SDK expects; the pool never guesses.
    """

    #: `anthropic`, and any adapter calling httpx directly.
    HTTPX = "httpx"
    #: `openai>=3` and everything reached through it: `openai`, `azure-openai`,
    #: and the OpenAI-wire self-hosted engines (LM Studio, vLLM).
    HTTPX2 = "httpx2"


#: Only a provider-DEFAULT `AiRuntimeProfile` row describes an upstream's pool.
#: A model-scoped row describes a model served ON that upstream, which has no
#: transport of its own — same convention as `EffectiveConfigSnapshot`.
_PROVIDER_DEFAULT_SLUG = ""

# ── Floors ───────────────────────────────────────────────────────────────────

#: Per-upstream ceiling on simultaneously open connections. Inherited from the
#: process-wide floor so a single upstream can, in the worst case, use the whole
#: budget — a floor bounds damage, it does not portion capacity out.
POOL_MAX_CONNECTIONS_FLOOR = HTTPX_MAX_CONNECTIONS

#: How many of those may be parked idle for reuse. This is the number that turns
#: "a TLS handshake per stream" into "a handshake per pool", which is the whole
#: point of B-2/B-8 — so the floor is generous, and a deployment SIZES it to the
#: real per-upstream concurrency rather than lowering it.
POOL_MAX_KEEPALIVE_FLOOR = HTTPX_MAX_KEEPALIVE

#: Seconds an idle connection is kept. Conservative on purpose: below every
#: upstream idle timeout we could plausibly meet, so the worst case is an extra
#: handshake rather than a reaped socket. See the module docstring.
POOL_KEEPALIVE_EXPIRY_FLOOR_S = 5.0

#: HTTP/2 is OFF at the floor. It is a genuine win on self-hosted engines, where
#: multiplexing removes the per-stream TCP connection (B-8) — and an unmeasured
#: guess on vendor endpoints, which is what 4.4/A-3 says to benchmark rather than
#: assume. "Measure, do not assume" is only enforceable if the default is off.
POOL_HTTP2_FLOOR = False

#: Threads the Bedrock stream bridge may hold. Sized from the SAME
#: `maxConcurrent` that bounds the Bedrock provider semaphore, so the pool can
#: never be the binding constraint (AC-8) and can never exceed the concurrency
#: the platform already agreed to.
BEDROCK_STREAM_WORKERS_FLOOR = PROVIDER_MAX_CONCURRENT_FLOOR

#: Thread-name prefix. Load-bearing: it is how an operator (and the AC-8 test)
#: tells a Bedrock stream thread from one of asyncio's `asyncio_N` defaults.
BEDROCK_STREAM_THREAD_PREFIX = "hope-text-bedrock-stream"


@dataclass(frozen=True)
class PoolPolicy:
    """One upstream's connection-pool shape."""

    max_connections: int = POOL_MAX_CONNECTIONS_FLOOR
    max_keepalive_connections: int = POOL_MAX_KEEPALIVE_FLOOR
    keepalive_expiry_s: float = POOL_KEEPALIVE_EXPIRY_FLOOR_S
    http2: bool = POOL_HTTP2_FLOOR

    def merged(self, served: dict[str, Any]) -> PoolPolicy:
        """This policy with any control-plane value applied over it.

        A key the control plane does not carry — or carries as null, or as a
        value that cannot mean anything (a zero connection ceiling, a negative
        expiry, a string where a bool belongs) — keeps the floor. Never coerce an
        absent or nonsensical opinion into a real limit.
        """
        updates = {
            name: value
            for name, value in served.items()
            if name in self.__dataclass_fields__ and value is not None
        }
        return replace(self, **updates) if updates else self

    def limits(self) -> httpx.Limits:
        return httpx.Limits(
            max_connections=self.max_connections,
            max_keepalive_connections=self.max_keepalive_connections,
            keepalive_expiry=self.keepalive_expiry_s,
        )

    def limits2(self) -> httpx2.Limits:
        """The same shape for the `httpx2` family — see the module docstring."""
        return httpx2.Limits(
            max_connections=self.max_connections,
            max_keepalive_connections=self.max_keepalive_connections,
            keepalive_expiry=self.keepalive_expiry_s,
        )


POOL_FLOOR = PoolPolicy()


# ── Process state ────────────────────────────────────────────────────────────
#
# A lock, because `apply_pool_policy` runs from the request path (via
# `refresh_runtime_limits`) on every worker task, while `pooled_http_client` runs
# from every adapter. Neither may observe a half-rebuilt map.

_LOCK = threading.RLock()
_POLICIES: dict[str, PoolPolicy] = {}
#: `(provider, family)` -> `(policy, timeout bucket, client)`.
_CLIENTS: dict[tuple[str, TransportFamily], tuple[PoolPolicy, int, Any]] = {}
_BEDROCK_EXECUTOR: ThreadPoolExecutor | None = None


def http2_supported() -> bool:
    """Whether the transport can actually negotiate HTTP/2 in this environment.

    `AsyncClient(http2=True)` raises `ImportError` when the optional `h2` package
    is absent — in BOTH families, with the same message. An egress proxy must not
    fail a tenant's generation because a transport extra was not installed, so the
    capability is PROBED and a policy asking for HTTP/2 degrades to HTTP/1.1 with
    a warning.
    """
    return importlib.util.find_spec("h2") is not None


def pool_policy_for(provider: str) -> PoolPolicy:
    """The effective pool shape for one upstream: served over the floor."""
    with _LOCK:
        return _POLICIES.get(provider, POOL_FLOOR)


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value > 0 else None


def _positive_float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value > 0 else None


def _strict_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _policy_from_profile(profile: dict[str, Any]) -> PoolPolicy:
    served: dict[str, Any] = {}
    for served_name, field_name, coerce in (
        ("poolMaxConnections", "max_connections", _positive_int),
        ("poolMaxKeepaliveConnections", "max_keepalive_connections", _positive_int),
        ("poolKeepaliveExpiryS", "keepalive_expiry_s", _positive_float),
        ("http2", "http2", _strict_bool),
    ):
        value = coerce(profile.get(served_name))
        if value is not None:
            served[field_name] = value
    return POOL_FLOOR.merged(served)


def apply_pool_policy(snapshot: EffectiveConfigSnapshot) -> set[str]:
    """Move the live pool shapes to match `snapshot`. Returns what changed.

    Every upstream whose policy changed has its pooled transport rebuilt AND its
    cached SDK clients evicted — a new pool shape is worthless while every client
    still holds the old transport. Unchanged upstreams keep their warm pool,
    which matters because this runs on the request path.

    Never raises: a config refresh may not break a request.
    """
    if not snapshot.ok:
        # Negative-cached (gateway down) — leave every live value exactly as-is,
        # the same posture as `apply_provider_limits`.
        return set()

    rebuilt: dict[str, PoolPolicy] = {}
    bedrock_workers: int | None = None
    for profile in snapshot.runtime_profiles:
        if not isinstance(profile, dict):
            continue
        if profile.get("modelSlug") != _PROVIDER_DEFAULT_SLUG:
            continue
        provider = profile.get("provider")
        if not isinstance(provider, str) or not provider:
            continue
        rebuilt[provider] = _policy_from_profile(profile)
        if provider == "bedrock":
            bedrock_workers = _positive_int(profile.get("maxConcurrent"))

    changed: set[str] = set()
    with _LOCK:
        for provider in set(rebuilt) | set(_POLICIES):
            before = _POLICIES.get(provider, POOL_FLOOR)
            after = rebuilt.get(provider, POOL_FLOOR)
            if before != after:
                changed.add(provider)
        _POLICIES.clear()
        _POLICIES.update(rebuilt)
        for key in [k for k in _CLIENTS if k[0] in changed]:
            _CLIENTS.pop(key, None)

    _resize_bedrock_executor(bedrock_workers or BEDROCK_STREAM_WORKERS_FLOOR)

    if changed:
        # The cached SDK clients hold the OLD transports, so they have to go with
        # them. Provider-scoped rather than wholesale: an unrelated upstream's
        # warm connections are not this change's business.
        for provider in changed:
            CLIENT_CACHE.evict_provider(provider)
        logger.info("text.pool.policy_applied", providers=sorted(changed))
    return changed


# ── Draining close: what actually returns a streamed socket to the pool ──────
#
# One client per upstream (4.2) buys nothing if every STREAM still ends in a
# fresh handshake, and until this wrapper existed every one did — measured at
# `1.000 conn/req` by `tests/bench/harness.py --tls --connections-per-request`,
# at concurrency 1, with the B-2 client cache and the B-8 pooled transport both
# confirmed hitting on every request.
#
# The drop is one layer below either cache. `openai`'s `AsyncStream.__stream__`
# `break`s out of its SSE loop on `data: [DONE]` and then closes the response in
# its `finally`. No application bytes remain at that point — but the HTTP
# END-OF-BODY marker (the chunked terminator) has not been read, so httpcore
# sees a partially-consumed response and tears the connection down rather than
# parking it for reuse. Reading those remaining zero bytes to EOF before the
# close is the whole fix; the non-streaming path never had the problem because
# it reads its body to completion.
#
# This lives at the TRANSPORT rather than in `openai_compat`, because the seam
# that leaks is `Response.aclose()` — by the time the adapter's `async for`
# returns, the SDK's `finally` has already closed and the socket is gone. Every
# adapter on a pooled client gets the fix for the same reason.

#: Bytes the close-time drain will read before giving up. A stream that ended
#: normally has ~0 left; a genuinely ABORTED one (consumer disconnected mid
#: generation) has the whole rest of the generation, and must NOT be read to
#: completion just to save a socket. A floor in the same sense as the pool
#: values above: it bounds the cost of the pathological case, it is not a
#: tuning knob.
DRAIN_ON_CLOSE_MAX_BYTES = 64 * 1024

#: Seconds the same drain may take. The normal case completes in one already
#: buffered read; anything slower is an abort wearing a drain's clothes.
DRAIN_ON_CLOSE_TIMEOUT_S = 0.25


class _DrainOnCloseMixin:
    """Read a response body to EOF (bounded) before closing it.

    Mixed into each HTTP family's own `AsyncByteStream` — httpx asserts the
    transport hands back one of ITS base class, and the two families are not
    interchangeable (module docstring).
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self._iterator: Any = None
        self._at_eof = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        # Keep the iterator: a consumer that `break`s leaves it SUSPENDED rather
        # than closed, which is exactly what makes the close-time drain possible.
        self._iterator = self._inner.__aiter__()
        async for part in self._iterator:
            yield part
        self._at_eof = True

    async def aclose(self) -> None:
        try:
            if not self._at_eof and self._iterator is not None:
                await self._drain()
        finally:
            # The close must happen even if the drain is cancelled or raises —
            # never leak a connection trying to save one.
            await self._inner.aclose()

    async def _drain(self) -> None:
        read = 0
        try:
            async with asyncio.timeout(DRAIN_ON_CLOSE_TIMEOUT_S):
                async for part in self._iterator:
                    read += len(part)
                    if read >= DRAIN_ON_CLOSE_MAX_BYTES:
                        return
        except Exception:
            # A drain is an optimisation. Timing out, or a transport that
            # refuses to be resumed, costs a handshake — never a request.
            return


def _draining_transport(base_cls: Any, family_module: Any) -> Any:
    """An `AsyncHTTPTransport` for one family whose responses drain on close."""

    class _Stream(_DrainOnCloseMixin, family_module.AsyncByteStream):
        pass

    class _Transport(base_cls):
        async def handle_async_request(self, request: Any) -> Any:
            response = await super().handle_async_request(request)
            response.stream = _Stream(response.stream)
            return response

    return _Transport


_HTTPX2_DRAINING_TRANSPORT = _draining_transport(httpx2.AsyncHTTPTransport, httpx2)
_HTTPX_DRAINING_TRANSPORT = _draining_transport(httpx.AsyncHTTPTransport, httpx)


def _build_client(
    provider: str, policy: PoolPolicy, family: TransportFamily, timeout_s: float
) -> httpx.AsyncClient | httpx2.AsyncClient:
    want_http2 = policy.http2
    if want_http2 and not http2_supported():
        logger.warning(
            "text.pool.http2_unavailable",
            provider=provider,
            detail="policy requests HTTP/2 but the 'h2' extra is not installed; "
            "negotiating HTTP/1.1",
        )
        want_http2 = False

    # `limits` and `http2` go to the TRANSPORT, not the client: an `AsyncClient`
    # given an explicit transport ignores both, so passing them twice would read
    # as configuration that is in fact inert.
    if family is TransportFamily.HTTPX2:
        return httpx2.AsyncClient(
            timeout=httpx2.Timeout(float(timeout_s)),
            transport=_HTTPX2_DRAINING_TRANSPORT(limits=policy.limits2(), http2=want_http2),
        )
    return httpx.AsyncClient(
        timeout=httpx.Timeout(float(timeout_s)),
        transport=_HTTPX_DRAINING_TRANSPORT(limits=policy.limits(), http2=want_http2),
    )


def pooled_http_client(
    provider: str,
    *,
    timeout_s: float,
    family: TransportFamily = TransportFamily.HTTPX,
) -> Any:
    """The ONE transport for `(provider, family)`, built from the current policy.

    One client per upstream (4.2). Memoized on `(policy, timeout)` so a policy
    change or a control-plane timeout push produces a new pool while an unchanged
    refresh keeps the connections warm — rebuilding on every refresh would undo
    the reuse this module exists to create.

    Returns `Any` deliberately: the concrete type is `httpx.AsyncClient` or
    `httpx2.AsyncClient` depending on `family`, and both SDKs annotate their own.
    A union return would push a cast into every adapter and buy nothing, because
    the family an adapter passes is fixed at its call site.
    """
    policy = pool_policy_for(provider)
    bucket = int(timeout_s)
    cache_key = (provider, family)
    with _LOCK:
        cached = _CLIENTS.get(cache_key)
        if cached is not None and cached[0] == policy and cached[1] == bucket:
            return cached[2]

        client = _build_client(provider, policy, family, timeout_s)
        _CLIENTS[cache_key] = (policy, bucket, client)
        return client


def reset_pooled_clients() -> None:
    """Drop every pooled transport and every SDK client built over one.

    The transports are dropped rather than closed: a request may still be
    streaming through one, and closing a live pool would abort a generation. The
    sockets go when the last reference does.
    """
    with _LOCK:
        _CLIENTS.clear()
    evict_all_clients("pool-reset")


# ── The Bedrock stream bridge's own threads (B-3) ────────────────────────────


def bedrock_stream_executor() -> ThreadPoolExecutor:
    """The dedicated, bounded pool the Bedrock stream bridge runs in.

    Never asyncio's default executor. The bridge holds a thread for the entire
    duration of a stream, so sharing the default pool means ~32 concurrent
    Bedrock generations stall every other `asyncio.to_thread` caller in the
    process — a ceiling Bedrock imposes on everyone else. A dedicated pool makes
    Bedrock's ceiling Bedrock's own.
    """
    global _BEDROCK_EXECUTOR
    with _LOCK:
        if _BEDROCK_EXECUTOR is None:
            _BEDROCK_EXECUTOR = ThreadPoolExecutor(
                max_workers=BEDROCK_STREAM_WORKERS_FLOOR,
                thread_name_prefix=BEDROCK_STREAM_THREAD_PREFIX,
            )
        return _BEDROCK_EXECUTOR


async def run_in_bedrock_executor(fn: Callable[[], _T]) -> _T:
    """Await one blocking Bedrock SDK call on Bedrock's own threads.

    The `asyncio.to_thread` replacement for the NON-streaming path. It is the
    same defect as B-3, one call shorter: a `converse` blocks its thread for the
    whole generation — seconds, not milliseconds — so on the default executor a
    burst of non-streaming Bedrock traffic starves every other `to_thread` caller
    exactly as the streams do.

    Living here rather than at the call site keeps ONE place that knows where
    Bedrock's blocking work runs, which is also what stops the boundary drifting
    back to the default executor one edit at a time.
    """
    return await asyncio.get_running_loop().run_in_executor(bedrock_stream_executor(), fn)


def _resize_bedrock_executor(workers: int) -> None:
    """Adopt the control plane's Bedrock concurrency as the thread ceiling.

    Applied IN PLACE. `ThreadPoolExecutor` reads `_max_workers` when deciding
    whether to spawn on submit, so raising it takes effect immediately; the pool
    is never swapped out, because each of its threads owns a live generation.

    Lowering it is recorded but frees no thread: `ThreadPoolExecutor` workers do
    not idle out. That is a bounded, deliberate limitation of the INTERIM fix —
    the structural fix (4.3: SigV4-signed direct HTTP over the shared httpx
    client) removes the threads entirely and is explicitly out of this lane.
    """
    executor = bedrock_stream_executor()
    with _LOCK:
        if executor._max_workers != workers:
            executor._max_workers = workers
            logger.info("text.pool.bedrock_workers_applied", workers=workers)
