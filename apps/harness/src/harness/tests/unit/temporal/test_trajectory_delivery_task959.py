"""TASK-957 F-5 / TASK-959 §10.2 — the trajectory POST gets a retry and a spool.

Before this, `_TrajectoryBatch.flush()` caught every exception, logged, and cleared its steps
in `finally`: a gateway restart or a 503 from the internal guard dropped those steps AND every
usage-ledger row they would have produced, permanently, while the run completed and delivered
its output. The seq-keyed idempotency already made a retry SAFE — the retry simply did not
exist.

What is asserted here:

* a transient failure is RETRIED, bounded by both an attempt count and a wall-clock budget, so
  a wedged gateway cannot hold a phase boundary hostage for three full HTTP timeouts;
* a terminal 4xx is NOT retried and NOT spooled — a contract error cannot be fixed by sending
  the same body again, and spooling it would poison the spool forever;
* an undeliverable batch is SPOOLED, and the next drain delivers it;
* a drain that fails puts the entry BACK, at the front, so ordering survives;
* nothing here ever raises into the caller: the fire-and-forget posture that two existing
  tests pin is unchanged.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from harness.services.api_client import (
    ApiClient,
    ApiClientError,
    ApiServiceError,
    TrajectoryStepInput,
    trajectory_body,
)
from harness.temporal import trajectory_delivery
from harness.temporal.compute_metering import ComputeSample
from harness.temporal.trajectory_delivery import (
    TrajectorySpool,
    deliver_trajectory,
    reset_trajectory_spool,
)


def _step(seq: int = 0) -> TrajectoryStepInput:
    return TrajectoryStepInput(
        tenant_id="t-1",
        session_id="wf-1",
        run_id="run-1",
        seq=seq,
        step_type="NODE",
        name="core.agent",
        status="OK",
        started_at="2026-09-12T00:00:00+00:00",
    )


def _sample(activity_id: str = "1") -> ComputeSample:
    return ComputeSample(
        tenant_id="t-1",
        session_id="wf-1",
        run_id="run-1",
        activity_id=activity_id,
        attempt=1,
        activity_type="core.agent",
        cpu_ms=1.25,
        wall_ms=40.0,
    )


def _client(handler) -> ApiClient:
    return ApiClient(
        "http://api:8868",
        internal_prefix="/internal/harness",
        service_token="svc-token",
        transport=httpx.MockTransport(handler),
    )


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch):
    """Instant retries: this suite asserts the retry COUNT, not the sleep schedule."""
    monkeypatch.setattr(trajectory_delivery, "BACKOFF_BASE_S", 0.0)
    monkeypatch.setattr(trajectory_delivery, "BACKOFF_JITTER_S", 0.0)
    reset_trajectory_spool()
    yield
    reset_trajectory_spool()


@pytest.fixture
def spool() -> TrajectorySpool:
    """A spool with no Redis — the hermetic suite's honest answer, memory fallback."""
    return TrajectorySpool(redis_factory=lambda: None)


class TestWireShape:
    def test_a_steps_only_post_is_byte_identical_to_before(self):
        assert trajectory_body([_step()], ()) == {"steps": [_step().to_wire()]}

    def test_a_compute_only_post_carries_no_steps_key(self):
        body = trajectory_body((), [_sample()])
        assert set(body) == {"computeSamples"}
        assert body["computeSamples"] == [
            {
                "tenantId": "t-1",
                "sessionId": "wf-1",
                "runId": "run-1",
                "activityId": "1",
                "attempt": 1,
                "activityType": "core.agent",
                "cpuMs": 1.25,
                "wallMs": 40.0,
            }
        ]

    def test_a_mixed_post_carries_both(self):
        body = trajectory_body([_step()], [_sample()])
        assert set(body) == {"steps", "computeSamples"}

    def test_an_empty_batch_is_an_empty_body(self):
        assert trajectory_body((), ()) == {}

    @pytest.mark.asyncio
    async def test_report_trajectory_posts_compute_samples_on_the_wire(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"accepted": 2})

        result = await _client(handler).report_trajectory(
            [_step()], compute_samples=[_sample()], idempotency_key="k-1"
        )

        request = seen["request"]
        assert str(request.url) == "http://api:8868/internal/harness/trajectory"
        assert request.headers["Idempotency-Key"] == "k-1"
        body = json.loads(request.content)
        assert body["steps"][0]["seq"] == 0
        assert body["computeSamples"][0]["cpuMs"] == 1.25
        assert result.accepted == 2


class TestRetry:
    @pytest.mark.asyncio
    async def test_a_transient_failure_is_retried_and_then_succeeds(self, spool):
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                return httpx.Response(503, json={"message": "gateway restarting"})
            return httpx.Response(200, json={"accepted": 1})

        landed = await deliver_trajectory(
            _client(handler), steps=[_step()], spool=spool
        )

        assert landed is True
        assert attempts == 3
        assert spool.pending() == 0

    @pytest.mark.asyncio
    async def test_the_attempt_count_is_bounded_and_the_batch_is_spooled(self, spool):
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            return httpx.Response(503, json={"message": "still down"})

        landed = await deliver_trajectory(
            _client(handler), steps=[_step()], spool=spool
        )

        assert landed is False
        assert attempts == trajectory_delivery.DELIVERY_ATTEMPTS
        assert spool.pending() == 1

    @pytest.mark.asyncio
    async def test_a_spent_wall_clock_budget_stops_further_attempts(self, monkeypatch, spool):
        """A wedged gateway must not cost three full HTTP timeouts at a phase boundary."""
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            raise httpx.ConnectError("refused")

        clock = iter([0.0, 99.0])
        monkeypatch.setattr(trajectory_delivery, "_now_s", lambda: next(clock))

        landed = await deliver_trajectory(
            _client(handler), steps=[_step()], spool=spool
        )

        assert landed is False
        assert attempts == 1  # the budget was already spent when attempt 2 was considered
        assert spool.pending() == 1

    @pytest.mark.asyncio
    async def test_a_terminal_4xx_is_neither_retried_nor_spooled(self, spool):
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            return httpx.Response(400, json={"message": "unknown property computeSamples"})

        landed = await deliver_trajectory(
            _client(handler), steps=[_step()], spool=spool
        )

        assert landed is False
        assert attempts == 1
        # Spooling a body the gateway REFUSES would retry it forever on every drain.
        assert spool.pending() == 0

    @pytest.mark.asyncio
    async def test_429_stays_on_the_retry_path(self, spool):
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(429, json={"message": "slow down"})
            return httpx.Response(200, json={"accepted": 1})

        assert await deliver_trajectory(_client(handler), steps=[_step()], spool=spool) is True
        assert attempts == 2

    @pytest.mark.asyncio
    async def test_an_empty_batch_makes_no_call_and_is_not_a_failure(self, spool):
        def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
            raise AssertionError("an empty batch must not be posted")

        assert await deliver_trajectory(_client(handler), spool=spool) is True

    @pytest.mark.asyncio
    async def test_an_unexpected_client_exception_never_escapes(self, spool):
        class _Exploding:
            async def report_trajectory(self, steps, *, idempotency_key=None):
                raise TypeError("client is not what we thought")

        assert await deliver_trajectory(_Exploding(), steps=[_step()], spool=spool) is False
        assert spool.pending() == 1


class TestSpool:
    @pytest.mark.asyncio
    async def test_a_spooled_batch_is_delivered_by_the_next_drain(self, spool):
        posts: list[dict[str, Any]] = []
        state = {"up": False}

        def handler(request: httpx.Request) -> httpx.Response:
            if not state["up"]:
                return httpx.Response(503, json={"message": "down"})
            posts.append(json.loads(request.content))
            return httpx.Response(200, json={"accepted": 1})

        client = _client(handler)
        assert await deliver_trajectory(client, steps=[_step(4)], spool=spool) is False
        assert spool.pending() == 1

        state["up"] = True
        drained = await spool.drain(
            lambda body: trajectory_delivery.deliver_trajectory_body(
                client, body, spool=spool, allow_spool=False
            ),
            max_entries=5,
        )

        assert drained == 1
        assert spool.pending() == 0
        assert posts[0]["steps"][0]["seq"] == 4

    @pytest.mark.asyncio
    async def test_a_drain_that_fails_puts_the_entry_back_at_the_front(self, spool):
        await spool.offer({"steps": [_step(1).to_wire()]})
        await spool.offer({"steps": [_step(2).to_wire()]})

        async def _always_fails(body: dict[str, Any]) -> bool:
            return False

        assert await spool.drain(_always_fails, max_entries=5) == 0
        assert spool.pending() == 2

        seen: list[int] = []

        async def _succeeds(body: dict[str, Any]) -> bool:
            seen.append(body["steps"][0]["seq"])
            return True

        assert await spool.drain(_succeeds, max_entries=5) == 2
        assert seen == [1, 2]  # order preserved across the failed attempt

    @pytest.mark.asyncio
    async def test_the_drain_is_bounded_per_call(self, spool):
        for seq in range(5):
            await spool.offer({"steps": [_step(seq).to_wire()]})

        async def _succeeds(body: dict[str, Any]) -> bool:
            return True

        assert await spool.drain(_succeeds, max_entries=2) == 2
        assert spool.pending() == 3

    @pytest.mark.asyncio
    async def test_the_memory_spool_is_bounded_and_drops_the_oldest(self):
        spool = TrajectorySpool(redis_factory=lambda: None, max_entries=2)
        for seq in range(4):
            await spool.offer({"steps": [_step(seq).to_wire()]})

        seen: list[int] = []

        async def _succeeds(body: dict[str, Any]) -> bool:
            seen.append(body["steps"][0]["seq"])
            return True

        assert await spool.drain(_succeeds, max_entries=10) == 2
        assert seen == [2, 3]

    @pytest.mark.asyncio
    async def test_an_empty_drain_is_a_no_op(self, spool):
        async def _never(body: dict[str, Any]) -> bool:  # pragma: no cover
            raise AssertionError("nothing to drain")

        assert await spool.drain(_never, max_entries=5) == 0


class TestRedisSpool:
    """The Redis path, against a fake client — the harness suite touches no real Redis."""

    @pytest.mark.asyncio
    async def test_offer_pushes_trims_and_expires(self):
        fake = _FakeRedis()
        spool = TrajectorySpool(redis_factory=lambda: fake, max_entries=7, ttl_s=99)

        await spool.offer({"steps": [_step(3).to_wire()]})

        assert len(fake.lists[trajectory_delivery.SPOOL_KEY]) == 1
        assert fake.trimmed == [(trajectory_delivery.SPOOL_KEY, -7, -1)]
        assert fake.expired == [(trajectory_delivery.SPOOL_KEY, 99)]
        entry = json.loads(fake.lists[trajectory_delivery.SPOOL_KEY][0])
        assert entry["body"]["steps"][0]["seq"] == 3
        # Worker + timestamp ride IN the entry, where they diagnose a past outage; the KEY is
        # shared so any worker can drain a batch a since-replaced pod could not deliver.
        assert entry["worker"]
        assert entry["spooledAt"]

    @pytest.mark.asyncio
    async def test_drain_pops_from_redis_and_re_pushes_a_failure_to_the_front(self):
        fake = _FakeRedis()
        spool = TrajectorySpool(redis_factory=lambda: fake)
        await spool.offer({"steps": [_step(1).to_wire()]})
        await spool.offer({"steps": [_step(2).to_wire()]})

        async def _always_fails(body: dict[str, Any]) -> bool:
            return False

        assert await spool.drain(_always_fails, max_entries=5) == 0
        assert len(fake.lists[trajectory_delivery.SPOOL_KEY]) == 2
        first = json.loads(fake.lists[trajectory_delivery.SPOOL_KEY][0])
        assert first["body"]["steps"][0]["seq"] == 1  # front, not appended at the tail

    @pytest.mark.asyncio
    async def test_a_broken_redis_degrades_to_the_memory_spool(self):
        class _Broken:
            async def rpush(self, *args: Any) -> int:
                raise RuntimeError("connection reset")

        spool = TrajectorySpool(redis_factory=lambda: _Broken())
        await spool.offer({"steps": [_step().to_wire()]})
        assert spool.pending() == 1  # kept, in memory, rather than lost


class _FakeRedis:
    def __init__(self) -> None:
        self.lists: dict[str, list[str]] = {}
        self.trimmed: list[tuple[str, int, int]] = []
        self.expired: list[tuple[str, int]] = []

    async def rpush(self, key: str, value: str) -> int:
        self.lists.setdefault(key, []).append(value)
        return len(self.lists[key])

    async def lpush(self, key: str, value: str) -> int:
        self.lists.setdefault(key, []).insert(0, value)
        return len(self.lists[key])

    async def lpop(self, key: str) -> str | None:
        values = self.lists.get(key) or []
        return values.pop(0) if values else None

    async def ltrim(self, key: str, start: int, end: int) -> bool:
        self.trimmed.append((key, start, end))
        return True

    async def expire(self, key: str, ttl: int) -> bool:
        self.expired.append((key, ttl))
        return True


class TestTheWorkerFacingDrain:
    """`drain_trajectory_spool` is what the worker's background flusher calls each tick."""

    @pytest.mark.asyncio
    async def test_it_redelivers_the_process_wide_spool(self, monkeypatch, settings):
        posted: list[dict[str, Any]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            posted.append(json.loads(request.content))
            return httpx.Response(200, json={"accepted": 1})

        monkeypatch.setattr(
            trajectory_delivery, "trajectory_api_client", lambda _s: _client(handler)
        )
        await trajectory_delivery.get_trajectory_spool().offer({"steps": [_step(6).to_wire()]})

        assert await trajectory_delivery.drain_trajectory_spool(settings) == 1
        assert posted[0]["steps"][0]["seq"] == 6
        assert trajectory_delivery.get_trajectory_spool().pending() == 0

    @pytest.mark.asyncio
    async def test_an_empty_spool_needs_no_client_at_all(self, monkeypatch, settings):
        def _explode(_s: Any) -> Any:  # pragma: no cover
            raise AssertionError("an empty drain must not build a client")

        monkeypatch.setattr(trajectory_delivery, "trajectory_api_client", _explode)
        assert await trajectory_delivery.drain_trajectory_spool(settings) == 0


class TestErrorClassificationIsUnchanged:
    """Guard rail: the retry decision is the client's existing classification, not a new one."""

    @pytest.mark.asyncio
    async def test_a_404_is_a_client_error_and_a_503_is_not(self):
        def four_oh_four(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={})

        def five_oh_three(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={})

        with pytest.raises(ApiClientError):
            await _client(four_oh_four).report_trajectory([_step()])
        with pytest.raises(ApiServiceError) as unavailable:
            await _client(five_oh_three).report_trajectory([_step()])
        assert not isinstance(unavailable.value, ApiClientError)
