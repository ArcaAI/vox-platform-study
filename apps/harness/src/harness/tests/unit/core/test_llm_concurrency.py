"""Tests for the shared per-endpoint LLM concurrency governor + retry.

The governor exists so the concurrent inferential pass (groundedness +
citation_verify + safety) can no longer burst the shared LM Studio box: all
callers hitting one endpoint collectively respect one admin-set cap, and transient
provider failures (429 / 5xx / connection / the LM Studio ``terminated`` 400) are
retried with backoff before the caller's fail-safe degrade takes over.
"""

from __future__ import annotations

import asyncio

import pytest

from harness.core.llm_concurrency import (
    LlmGovernorConfig,
    endpoint_key,
    endpoint_semaphore,
    get_llm_governor_config,
    governed_request,
    is_retryable,
    reset_endpoint_limiters,
)

# Zero-delay retry config so the retry tests stay fast/hermetic.
FAST = LlmGovernorConfig(
    max_concurrency=1, max_attempts=4, backoff_base_s=0.0, backoff_max_s=0.0, jitter_s=0.0
)


@pytest.fixture(autouse=True)
def _clean_limiters():
    reset_endpoint_limiters()
    yield
    reset_endpoint_limiters()


class _FakeResponse:
    def __init__(self, status_code: int | None, headers: dict | None, text: str) -> None:
        self.status_code = status_code
        self.headers = headers or {}
        self.text = text


def _http_error(
    message: str,
    *,
    status_code: int | None = None,
    retry_after: str | None = None,
    body: str = "",
    top_level_status: bool = True,
) -> Exception:
    """Build an openai/httpx-shaped error (``.status_code`` / ``.response.*``)."""
    exc = Exception(message)
    headers = {"retry-after": retry_after} if retry_after is not None else {}
    exc.response = _FakeResponse(status_code, headers, body)  # type: ignore[attr-defined]
    if top_level_status and status_code is not None:
        exc.status_code = status_code  # type: ignore[attr-defined]
    return exc


# --------------------------------------------------------------------------- #
# endpoint normalization + shared-limiter identity
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "url,expected",
    [
        ("http://localhost:1234/v1", "http://localhost:1234"),
        ("http://localhost:1234", "http://localhost:1234"),
        ("http://LocalHost:1234/v1/", "http://localhost:1234"),
        ("localhost:1234", "http://localhost:1234"),
        ("https://example.openai.azure.com", "https://example.openai.azure.com"),
        ("http://localhost:11434", "http://localhost:11434"),
    ],
)
def test_endpoint_key_collapses_path_and_casing(url, expected):
    assert endpoint_key(url) == expected


@pytest.mark.asyncio
async def test_same_endpoint_shares_one_semaphore_across_callers():
    # The judge (…/v1), the safety guardian (…/v1) and the embeddings client (…/v1)
    # must collapse onto ONE limiter so the cap is shared across all three.
    judge = endpoint_semaphore("http://localhost:1234/v1", 3)
    safety = endpoint_semaphore("http://localhost:1234", 3)
    embeddings = endpoint_semaphore("http://localhost:1234/v1/", 3)
    assert judge is safety is embeddings


@pytest.mark.asyncio
async def test_distinct_endpoints_get_independent_semaphores():
    lm_studio = endpoint_semaphore("http://localhost:1234/v1", 1)
    reranker = endpoint_semaphore("http://localhost:8870", 1)
    assert lm_studio is not reranker


# --------------------------------------------------------------------------- #
# concurrency cap
# --------------------------------------------------------------------------- #


class _ConcurrencyProbe:
    """Tracks the peak number of operations in flight."""

    def __init__(self) -> None:
        self.in_flight = 0
        self.peak = 0

    async def run(self) -> str:
        self.in_flight += 1
        self.peak = max(self.peak, self.in_flight)
        try:
            await asyncio.sleep(0.02)  # hold the slot long enough to overlap
            return "ok"
        finally:
            self.in_flight -= 1


@pytest.mark.asyncio
async def test_governor_never_exceeds_cap_on_one_endpoint():
    probe = _ConcurrencyProbe()
    cfg = LlmGovernorConfig(max_concurrency=2, max_attempts=1)
    await asyncio.gather(
        *(governed_request("http://localhost:1234/v1", probe.run, config=cfg) for _ in range(10))
    )
    assert probe.peak == 2  # fanned out 10, but never more than 2 in flight


@pytest.mark.asyncio
async def test_cap_is_shared_across_different_base_urls_same_box():
    # Two "clients" with different base_url spellings for the SAME box must share
    # the cap (this is the burst fix: judge + safety + embeddings on :1234).
    probe = _ConcurrencyProbe()
    cfg = LlmGovernorConfig(max_concurrency=2, max_attempts=1)
    urls = ["http://localhost:1234/v1", "http://localhost:1234"]
    await asyncio.gather(
        *(governed_request(urls[i % 2], probe.run, config=cfg) for i in range(10))
    )
    assert probe.peak == 2


@pytest.mark.asyncio
async def test_distinct_endpoints_run_concurrently():
    # Independent endpoints are independently capped, so work on different boxes
    # proceeds in parallel (cap is per-endpoint, not global).
    a = _ConcurrencyProbe()
    b = _ConcurrencyProbe()
    cfg = LlmGovernorConfig(max_concurrency=1, max_attempts=1)
    await asyncio.gather(
        governed_request("http://localhost:1234/v1", a.run, config=cfg),
        governed_request("http://localhost:8870", b.run, config=cfg),
        governed_request("http://localhost:1234/v1", a.run, config=cfg),
        governed_request("http://localhost:8870", b.run, config=cfg),
    )
    assert a.peak == 1 and b.peak == 1  # each box capped at 1...
    # ...but they overlapped (both reached 1 in-flight during the run).


# --------------------------------------------------------------------------- #
# rate-limit-aware retry
# --------------------------------------------------------------------------- #


def _flaky(*, fail_times: int, error_factory, result: str = "ok"):
    state = {"attempts": 0}

    async def op():
        state["attempts"] += 1
        if state["attempts"] <= fail_times:
            raise error_factory()
        return result

    return op, state


@pytest.mark.asyncio
async def test_retry_on_429_honors_retry_after(monkeypatch):
    slept: list[float] = []
    real_sleep = asyncio.sleep

    async def fake_sleep(delay):
        slept.append(delay)
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    op, state = _flaky(
        fail_times=1,
        error_factory=lambda: _http_error("rate limited", status_code=429, retry_after="7"),
    )
    out = await governed_request("http://localhost:1234/v1", op, config=FAST)
    assert out == "ok"
    assert state["attempts"] == 2
    assert slept == [7.0]  # honored Retry-After, not the (zero) backoff


@pytest.mark.asyncio
async def test_retry_on_5xx_then_succeeds():
    op, state = _flaky(
        fail_times=2,
        error_factory=lambda: _http_error("server error", status_code=503),
    )
    out = await governed_request("http://localhost:1234/v1", op, config=FAST)
    assert out == "ok"
    assert state["attempts"] == 3


@pytest.mark.asyncio
async def test_retry_on_terminated_400_then_succeeds():
    # LM Studio terminates/unloads the model engine mid-run (HTTP 400 'terminated'),
    # then JIT-reloads on the next call — that specific 400 IS retryable.
    op, state = _flaky(
        fail_times=2,
        error_factory=lambda: _http_error(
            "Bad Request", status_code=400, body='{"error":"terminated"}'
        ),
    )
    out = await governed_request("http://localhost:1234/v1", op, config=FAST)
    assert out == "ok"
    assert state["attempts"] == 3


@pytest.mark.asyncio
async def test_retry_on_connection_error_then_succeeds():
    op, state = _flaky(
        fail_times=1,
        error_factory=lambda: Exception("Connection error: all attempts failed"),
    )
    out = await governed_request("http://localhost:1234/v1", op, config=FAST)
    assert out == "ok"
    assert state["attempts"] == 2


@pytest.mark.asyncio
async def test_gives_up_after_max_attempts_then_raises():
    # A backend that never recovers must surface the error after the bounded budget
    # so the caller's fail-safe degrade owns the outcome (never a silent pass).
    op, state = _flaky(
        fail_times=99,
        error_factory=lambda: _http_error("server error", status_code=500),
    )
    with pytest.raises(Exception, match="server error"):
        await governed_request("http://localhost:1234/v1", op, config=FAST)
    assert state["attempts"] == FAST.max_attempts


@pytest.mark.asyncio
async def test_non_retryable_4xx_fails_fast():
    # A deterministic client error (e.g. malformed request) would only fail again,
    # so it must NOT be retried.
    op, state = _flaky(
        fail_times=99,
        error_factory=lambda: _http_error("bad request", status_code=400, body="invalid messages"),
    )
    with pytest.raises(Exception, match="bad request"):
        await governed_request("http://localhost:1234/v1", op, config=FAST)
    assert state["attempts"] == 1


def test_is_retryable_classification():
    assert is_retryable(_http_error("x", status_code=429))
    assert is_retryable(_http_error("x", status_code=503))
    assert is_retryable(_http_error("t", status_code=400, body='{"error":"terminated"}'))
    assert is_retryable(Exception("Connection reset by peer"))
    assert not is_retryable(_http_error("x", status_code=400, body="plain bad request"))
    assert not is_retryable(_http_error("x", status_code=401))


# --------------------------------------------------------------------------- #
# per-call wall-clock timeout
# --------------------------------------------------------------------------- #


def test_request_timeout_default_is_120():
    # Safety net for the raised HARNESS_LLM_MAX_CONCURRENCY: a hung
    # call must be bounded by default, not only when an operator opts in.
    assert LlmGovernorConfig().request_timeout_s == 120.0


def test_get_llm_governor_config_reads_request_timeout(monkeypatch):
    monkeypatch.setenv("HARNESS_LLM_REQUEST_TIMEOUT_S", "42")
    assert get_llm_governor_config().request_timeout_s == 42.0


def test_is_retryable_treats_timeout_as_transient():
    # A per-call timeout is a transient hang, retried within the budget like any 5xx.
    # ``asyncio.timeout`` raises a bare builtin ``TimeoutError`` (empty message) on 3.11+
    # — ``asyncio.TimeoutError`` is the same class — so marker-matching alone would miss it.
    assert is_retryable(TimeoutError("llm request exceeded 120s per-call timeout"))
    assert is_retryable(TimeoutError())


@pytest.mark.asyncio
async def test_request_timeout_aborts_hung_operation_and_retries_then_raises():
    # A call that never responds is cut at request_timeout_s, classified transient, and
    # retried up to max_attempts before re-raising (caller's degrade owns the outcome).
    cfg = LlmGovernorConfig(
        max_concurrency=1,
        max_attempts=3,
        backoff_base_s=0.0,
        backoff_max_s=0.0,
        jitter_s=0.0,
        request_timeout_s=0.05,
    )
    state = {"attempts": 0}

    async def hung():
        state["attempts"] += 1
        await asyncio.sleep(30)

    with pytest.raises(TimeoutError):
        await asyncio.wait_for(
            governed_request("http://localhost:1234/v1", hung, config=cfg), timeout=5.0
        )
    assert state["attempts"] == 3  # retried within max_attempts before giving up


@pytest.mark.asyncio
async def test_request_timeout_zero_disables_the_bound():
    # A non-positive timeout disables the wall-clock bound (a finite call still completes).
    cfg = LlmGovernorConfig(max_concurrency=1, max_attempts=1, request_timeout_s=0.0)

    async def quick():
        await asyncio.sleep(0)
        return "ok"

    assert await governed_request("http://localhost:1234/v1", quick, config=cfg) == "ok"


@pytest.mark.asyncio
async def test_backoff_is_bounded_and_jittered(monkeypatch):
    slept: list[float] = []
    real_sleep = asyncio.sleep

    async def fake_sleep(delay):
        slept.append(delay)
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    cfg = LlmGovernorConfig(
        max_concurrency=1, max_attempts=5, backoff_base_s=1.0, backoff_max_s=4.0, jitter_s=0.5
    )
    op, _ = _flaky(fail_times=99, error_factory=lambda: _http_error("e", status_code=500))
    with pytest.raises(Exception, match="e"):
        await governed_request("http://localhost:1234/v1", op, config=cfg)
    # 4 backoffs (5 attempts): exponential 1,2,4,4 (capped at max) + [0,jitter).
    assert len(slept) == 4
    for delay, expected_base in zip(slept, [1.0, 2.0, 4.0, 4.0], strict=False):
        assert expected_base <= delay <= expected_base + cfg.jitter_s
