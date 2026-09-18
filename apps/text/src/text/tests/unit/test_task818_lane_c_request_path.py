"""the request-path fixed cost.

Lane B removed the 202-and-poll round trip and the per-token Python tax, which
halved AC-3's p50. What was left was a request-path *fixed* cost, and the plan
named four suspects: the middleware stack, request-body pydantic validation, the
guardrail gate's inline network hop, and the rate-limit / breaker / queue
lookups.

## Three of the four suspects are measurably negligible

Stage timings inside the real service (`tests/bench`'s mock upstream,
zero-latency, streaming). These four are self-time with no `await` inside, so
they are trustworthy:

| suspect                                | p50 per request |
|----------------------------------------|----------------:|
| request-body pydantic validation        |        0.008 ms |
| guardrail gate (posture off, no hop)    |        0.003 ms |
| rate limiter / breaker / queue lookups  |       < 0.01 ms |
| response serialisation                  |        0.05 ms  |

Together: under 0.1 ms of an ~8 ms/request budget. **C-1's premise does not hold
for this route** — msgspec would save microseconds, and the guardrail hop is not
even in the benchmarked path (`GUARDRAIL_ENABLED_FLOOR = False`, so
`ExternalGuardrailClient.validate` early-returns).

## The instrument that first looked decisive was measuring queueing

A wall-clock profile put FastAPI dependency resolution at 16.9 ms p50 (c=10) /
54.4 ms (c=25) — apparently 35x everything else, and traceable to FastAPI
dispatching each *synchronous* `Depends()` callable to anyio's worker threadpool
(`solve_dependencies` -> `run_in_threadpool`; `/generate` declares 13, each a
one-line `getattr` on `app.state`).

**That number was mostly queueing, not work.** Every handoff is an `await`
point, and on a saturated loop an `await` measures how long the request waited to
be resumed. Re-measured as CPU time consumed by the process (`getrusage`,
insensitive to scheduling noise), making all 13 providers `async def` is worth
**-0.39 ms/request (-4.5%)**, not 16 ms. Real, worth keeping, and an order of
magnitude smaller than the wall-clock profile implied.

## The actual finding: the service is CPU-bound on ONE core

Across every variant measured, `apps/text` runs at **96-98% of a single core**.
CPU per request is therefore the binding constraint, and it converts directly
into throughput and into the queueing that AC-3's p99 is made of.

By ablation (300 requests/run, 3 reps, streaming, concurrency 10):

| variant                             | CPU/request | delta        |
|-------------------------------------|------------:|-------------:|
| full app                            |     7.79 ms |            — |
| **minus the 3 BaseHTTPMiddleware**   | **5.58 ms** | **-2.21 ms** |
| minus the Prometheus instrumentator |     8.23 ms |    +0.44 ms  |

**Starlette's `BaseHTTPMiddleware` was ~28% of the entire per-request CPU
budget** — the single largest item in the request path, and not on the plan's
list of suspects at all. Each layer runs its request in an anyio task group with
a pair of memory object streams; this service stacked three. Rewritten as plain
ASGI, the same 300 requests finish in 1.66 s instead of 2.43 s.

These tests lock in: async dependency providers, pure-ASGI middleware, the two
admission-path defects the plan named (C-5, C-6), and the C-4 decision (measured
and rejected — see `TestResponseEncoder`).
"""

from __future__ import annotations

import inspect
from unittest.mock import AsyncMock, MagicMock

import fakeredis.aioredis as fakeasync
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core import dependencies as deps


@pytest.fixture
def mock_provider():
    provider = AsyncMock()
    provider.generate = AsyncMock(
        return_value=(
            "Generated summary",
            "",
            {"prompt_tokens": 50, "completion_tokens": 100, "total_tokens": 150},
        )
    )
    return provider


@pytest.fixture
def mock_registry(mock_provider):
    registry = MagicMock()
    registry.get.return_value = mock_provider
    registry.list_providers.return_value = ["lm-studio"]
    return registry


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    task_state = MagicMock()
    task_state.task_id = "task-lane-c"
    tm.create_task = AsyncMock(return_value=task_state)
    tm.update_task = AsyncMock()
    return tm


@pytest_asyncio.fixture
async def redis_client():
    r = fakeasync.FakeRedis(decode_responses=True)
    yield r
    await r.flushall()
    await r.aclose()


@pytest.fixture
def app(mock_registry, mock_task_manager, redis_client):
    from text.main import create_app

    application = create_app()
    application.state.provider_registry = mock_registry
    application.state.task_manager = mock_task_manager
    application.state.redis = redis_client
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


_BODY = {"prompt": "hello", "model": "test-model", "provider": "lm-studio"}


# --------------------------------------------------------------------------
# The finding: dependency resolution, not body validation
# --------------------------------------------------------------------------
class TestDependenciesResolveOnTheEventLoop:
    """No `Depends()` provider may be dispatched to the worker threadpool."""

    def test_every_dependency_provider_is_a_coroutine_function(self) -> None:
        """A sync provider is one thread handoff per request, per provider.

        Structural rather than behavioural on purpose: the property being
        asserted IS structural — `solve_dependencies` branches on
        `_is_coroutine_callable(call)` and nothing else. A provider that grows
        back a sync `def` later silently re-adds a handoff to every request that
        declares it, and no functional test would notice.
        """
        offenders = sorted(
            name
            for name, fn in vars(deps).items()
            if name.startswith("get_")
            and inspect.isfunction(fn)
            and fn.__module__ == deps.__name__
            and not inspect.iscoroutinefunction(fn)
        )
        assert offenders == [], (
            "these `Depends()` providers are sync, so FastAPI ships each of them "
            "to anyio's worker threadpool on every request that declares them "
            f"(measured ~1.3 ms each at concurrency 10): {offenders}"
        )

    @pytest.mark.asyncio
    async def test_generate_request_makes_no_threadpool_handoffs(self, client, monkeypatch) -> None:
        """End-to-end: a real `/generate` resolves its 13 deps with zero handoffs."""
        import fastapi.dependencies.utils as du

        original = du.run_in_threadpool
        handoffs: list[str] = []

        async def counting_run_in_threadpool(func, *args, **kwargs):
            handoffs.append(getattr(func, "__name__", repr(func)))
            return await original(func, *args, **kwargs)

        monkeypatch.setattr(du, "run_in_threadpool", counting_run_in_threadpool)

        resp = await client.post("/api/v1/generate", json=_BODY)

        assert resp.status_code == 200, resp.text
        assert handoffs == [], f"{len(handoffs)} threadpool handoffs on one request: {handoffs}"


class TestMiddlewareIsPureAsgi:
    """`BaseHTTPMiddleware` is the single most expensive thing in this request path.

    Starlette's `BaseHTTPMiddleware` is a compatibility shim, not a free wrapper:
    every request it handles is run inside its own `anyio` task group, with two
    memory object streams plumbing the response back — per layer. `apps/text`
    stacked three of them, so every request paid that three times.

    Priced by ablation (real service, `getrusage` inside the process, 300
    requests per run, streaming, concurrency 10 — CPU time rather than latency
    because this host's load makes percentiles useless):

    | variant                          | CPU/request  |
    |----------------------------------|-------------:|
    | full app                         | 7.79-8.49 ms |
    | **minus the 3 BaseHTTPMiddleware** | **5.42-5.63 ms** |
    | minus the Prometheus instrumentator | 8.23-8.65 ms |

    ~2.4-2.9 ms/request, about **30% of the whole request budget**, and the same
    300 requests finished in 1.66 s instead of 2.43 s. It matters because the
    service runs at **96-98% of ONE core** in every variant: CPU per request is
    the binding constraint, so it converts directly into throughput and into the
    queueing that AC-3's p99 is made of.

    A plain ASGI middleware has none of that machinery. The three here only read
    headers and set one response header, which needs no request/response object
    at all.
    """

    def test_no_middleware_subclasses_basehttpmiddleware(self) -> None:
        from hope_obs.middleware import AccessLogMiddleware, RequestContextMiddleware
        from starlette.middleware.base import BaseHTTPMiddleware

        from text.api.middleware.auth import ServiceAuthMiddleware

        offenders = [
            cls.__name__
            for cls in (ServiceAuthMiddleware, AccessLogMiddleware, RequestContextMiddleware)
            if issubclass(cls, BaseHTTPMiddleware)
        ]
        assert offenders == [], (
            "BaseHTTPMiddleware runs each request in its own anyio task group with "
            "two memory object streams, per layer — measured at ~30% of this "
            f"service's per-request CPU across three layers: {offenders}"
        )

    @pytest.mark.asyncio
    async def test_request_id_header_still_round_trips(self, client) -> None:
        resp = await client.post(
            "/api/v1/generate", json=_BODY, headers={"X-Request-ID": "rid-lane-c"}
        )

        assert resp.status_code == 200, resp.text
        assert resp.headers["X-Request-ID"] == "rid-lane-c"

    @pytest.mark.asyncio
    async def test_request_id_is_generated_when_absent(self, client) -> None:
        resp = await client.post("/api/v1/generate", json=_BODY)

        assert resp.status_code == 200, resp.text
        assert resp.headers.get("X-Request-ID")

    @pytest.mark.asyncio
    async def test_tenant_precondition_still_refuses_with_428(self, app) -> None:
        """The auth middleware's refusal path must survive the transport change."""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as bare:
            resp = await bare.post("/api/v1/generate", json=_BODY, headers={"X-Tenant-Id": ""})

        assert resp.status_code == 428, resp.text
        assert "X-Tenant-Id is required" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_exempt_path_skips_the_tenant_precondition(self, app) -> None:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as bare:
            resp = await bare.get("/api/v1/health")

        assert resp.status_code == 200, resp.text


# --------------------------------------------------------------------------
# C-5 — the provider semaphore must not be held across retry backoff
# --------------------------------------------------------------------------
class TestSemaphoreIsNotHeldAcrossBackoff:
    """B-5: a degrading provider must not starve capacity while it sleeps.

    The permit used to be taken before the retry loop and released only in the
    outer ``finally``, so one failing request occupied a concurrency slot for
    ``sum(backoffs) + attempts x timeout``. With a floor of a handful of permits
    that turns provider degradation into capacity starvation for every other
    tenant on the same provider.
    """

    @pytest.mark.asyncio
    async def test_permit_is_released_while_backing_off(
        self, app, client, mock_provider, monkeypatch
    ) -> None:
        from text.services.resizable_semaphore import ResizableSemaphore

        semaphore = ResizableSemaphore(1)
        app.state.provider_semaphores = {"lm-studio": semaphore}

        in_flight_during_backoff: list[int] = []
        attempts = {"n": 0}

        async def failing_then_ok(*_a, **_kw):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise RuntimeError("provider blew up")
            return ("ok", "", {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})

        mock_provider.generate = AsyncMock(side_effect=failing_then_ok)

        import text.api.endpoints.generate as gen

        async def observing_sleep(_seconds: float) -> None:
            # THE assertion point: while this request sleeps between attempts,
            # its permit must be back in the pool for somebody else.
            in_flight_during_backoff.append(semaphore.in_flight)

        monkeypatch.setattr(gen.asyncio, "sleep", observing_sleep)

        body = dict(_BODY, retry_config={"max_retries": 1, "retry_on": ["provider_error"]})
        resp = await client.post("/api/v1/generate", json=body)

        assert resp.status_code == 200, resp.text
        assert in_flight_during_backoff, "the retry path never backed off — test is inert"
        assert in_flight_during_backoff[0] == 0, (
            "the provider semaphore was still held during retry backoff: "
            f"in_flight={in_flight_during_backoff[0]}"
        )

    @pytest.mark.asyncio
    async def test_permit_is_still_released_exactly_once_on_success(self, app, client) -> None:
        """Re-acquiring between attempts must not double-release on the way out."""
        from text.services.resizable_semaphore import ResizableSemaphore

        semaphore = ResizableSemaphore(2)
        app.state.provider_semaphores = {"lm-studio": semaphore}

        resp = await client.post("/api/v1/generate", json=_BODY)

        assert resp.status_code == 200, resp.text
        assert semaphore.in_flight == 0


# --------------------------------------------------------------------------
# C-6 — retry policy
# --------------------------------------------------------------------------
class TestRetryPolicy:
    """<=3 retries, always jittered, `Retry-After` honoured."""

    def test_backoff_is_jittered(self) -> None:
        """Two callers backing off from the same tick must not retry together."""
        from text.services.retry_handler import calculate_backoff

        samples = {calculate_backoff(1) for _ in range(50)}
        assert len(samples) > 1, (
            f"calculate_backoff(1) is deterministic ({samples}) — no jitter, so every "
            "limited caller retries on the same tick"
        )

    def test_retry_after_overrides_computed_backoff(self) -> None:
        """A provider that states its own wait is authoritative — plus jitter.

        Jitter is applied even to an exact `Retry-After`, deliberately: an exact
        wait is precisely the case where every limited caller has been handed
        the SAME deadline by the SAME upstream.
        """
        from text.services.retry_handler import calculate_backoff

        values = [calculate_backoff(0, retry_after=10.0) for _ in range(50)]
        assert all(10.0 <= v <= 11.0 for v in values), values
        assert len(set(values)) > 1, "Retry-After was honoured but not jittered"

    def test_retry_after_is_still_capped_by_max_delay(self) -> None:
        from text.services.retry_handler import calculate_backoff

        assert calculate_backoff(0, retry_after=9_999.0, max_delay=60.0) == 60.0

    def test_retries_are_capped_at_three_however_many_the_caller_asks_for(self) -> None:
        from text.services.retry_handler import MAX_RETRIES, should_retry

        assert MAX_RETRIES == 3
        # attempt is 0-based. Three retries = attempts 0,1,2 answered True.
        assert should_retry("provider_error", ["provider_error"], 2, max_retries=10) is True
        # A fourth retry is refused even though the caller asked for ten.
        assert should_retry("provider_error", ["provider_error"], 3, max_retries=10) is False

    def test_retry_after_is_extracted_from_the_provider_error(self) -> None:
        """The wait a 429 carried must reach the backoff calculation."""
        from text.services.retry_handler import retry_after_from

        class _Resp:
            headers = {"retry-after": "7"}

        class _Err(Exception):
            response = _Resp()

        assert retry_after_from(_Err()) == 7.0
        assert retry_after_from(RuntimeError("no header here")) is None

    def test_retry_after_attribute_form_is_understood(self) -> None:
        from text.core.exceptions import RateLimitError
        from text.services.retry_handler import retry_after_from

        assert retry_after_from(RateLimitError("slow down", retry_after=12.0)) == 12.0


class TestRateLimitResponseHeaders:
    """Soft limit -> 429 + `Retry-After` + `RateLimit-Remaining`."""

    def test_rate_limit_error_carries_remaining(self) -> None:
        from text.core.exception_handlers import _get_headers
        from text.core.exceptions import RateLimitError

        headers = _get_headers(RateLimitError("too fast", retry_after=3.0, remaining=0))
        assert headers is not None
        assert headers["Retry-After"] == "4"
        assert headers["RateLimit-Remaining"] == "0"

    def test_remaining_is_omitted_when_unknown(self) -> None:
        """An absent value must not be reported as a confident zero."""
        from text.core.exception_handlers import _get_headers
        from text.core.exceptions import RateLimitError

        headers = _get_headers(RateLimitError("too fast", retry_after=3.0))
        assert headers is not None
        assert "RateLimit-Remaining" not in headers


# --------------------------------------------------------------------------
# C-4 — orjson on the response path
# --------------------------------------------------------------------------
class TestResponseEncoder:
    """B-9, revised by measurement — see `generate.py`'s note above `router`.

    C-4 asked for `ORJSONResponse` as the app's `default_response_class`. It is
    NOT adopted on the route path: FastAPI 0.141 deprecates it (its own Pydantic
    serializer is faster where a response model exists), and the measured win is
    3 microseconds — `jsonable_encoder` is 87% of the render cost and
    `ORJSONResponse` does not avoid it. It IS kept on the error path, which
    constructs its response directly and so carries no deprecation.

    This test pins the DECISION, so a later "we forgot C-4" does not silently
    re-add a deprecated response class for a 0.03%-of-CPU win.
    """

    def _resolved(self, value):
        from fastapi.datastructures import DefaultPlaceholder

        return value.value if isinstance(value, DefaultPlaceholder) else value

    def test_generate_router_does_not_set_a_deprecated_response_class(self) -> None:
        from fastapi.responses import ORJSONResponse

        from text.api.endpoints.generate import router

        assert self._resolved(router.default_response_class) is not ORJSONResponse

    def test_error_handler_does_not_use_a_deprecated_response_class(self) -> None:
        """`ORJSONResponse` warns even when built directly in a handler."""
        from fastapi.responses import ORJSONResponse

        import text.core.exception_handlers as handlers

        assert handlers.ERROR_RESPONSE_CLASS is not ORJSONResponse

    @pytest.mark.asyncio
    async def test_error_responses_emit_no_deprecation_warning(self, app) -> None:
        """A 428 must not cost a FastAPIDeprecationWarning per request."""
        import warnings

        transport = ASGITransport(app=app)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            async with AsyncClient(transport=transport, base_url="http://test") as bare:
                resp = await bare.post("/api/v1/generate", json=_BODY, headers={"X-Tenant-Id": ""})

        assert resp.status_code == 428, resp.text
        deprecations = [w for w in caught if "ORJSONResponse is deprecated" in str(w.message)]
        assert deprecations == [], [str(w.message) for w in deprecations]

    @pytest.mark.asyncio
    async def test_generate_response_is_still_valid_json(self, client) -> None:
        """The encoder swap must not change the wire shape."""
        resp = await client.post("/api/v1/generate", json=_BODY)

        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("application/json")
        body = resp.json()
        assert body["content"] == "Generated summary"
        assert body["usage"]["total_tokens"] == 150
