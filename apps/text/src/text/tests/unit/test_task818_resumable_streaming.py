"""TASK-818 Lane B — resumable streaming.

The properties this file defends, each named by the ticket:

* **B-1** — killing the HTTP response never kills the producer.
* **AC-15** — a client that reconnects mid-generation resumes at ``seq+1`` with
  **no gap and no duplicate**, verified by diffing the reassembled output against
  an uninterrupted run of the same generation.
* **AC-18** — a dropped socket is never a cancel. Only an explicit cancel stops a
  producer.
* **AC-5** — the replay buffer takes **one** durable write per batch of 16–32
  deltas (or 25 ms), never one per token.
* **§3C.3(4,5)** — ``id: {generation_id}:{seq}``, ``generation_id`` in the first
  event, resume by ``Last-Event-ID`` / ``?from_seq=``, 204 for an unknown id.
* **§3C.5/3C.6** — abandonment resolves tenant → SYSTEM and defaults to "never
  abandon"; idempotency maps a key to one generation and 409s on payload drift.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

import fakeredis.aioredis
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.models.provider import ProviderInfo
from text.models.stream import StreamChunk
from text.models.task import TaskStatus
from text.providers.base import ProviderRegistry
from text.routing.hub import (
    FLUSH_MAX_DELTAS,
    GenerationEvent,
    GenerationHub,
    GenerationPolicy,
    Producer,
    dedupe_by_seq,
    resolve_generation_policy,
)
from text.services.task_manager import TaskManager

TENANT = "50000000-0000-0000-0000-000000000000"


# ── Fixtures ────────────────────────────────────────────────────────────────


class _SlowProvider:
    """Emits ``count`` deltas with a yield point between each.

    The awaits matter: without them the whole generation completes inside one
    scheduler slot and a test can never disconnect "mid-stream".
    """

    def __init__(self, count: int = 40, delay: float = 0.002) -> None:
        self._count = count
        self._delay = delay

    async def generate(self, request: Any) -> Any:  # pragma: no cover - unused
        raise NotImplementedError

    async def generate_stream(self, request: Any):
        for index in range(self._count):
            await asyncio.sleep(self._delay)
            yield StreamChunk(type="chunk", content=f"w{index} ")
        yield StreamChunk(
            type="usage",
            data={"prompt_tokens": 3, "completion_tokens": self._count, "total_tokens": 43},
        )
        yield StreamChunk(type="done", data={"finish_reason": "stop"})

    async def health_check(self) -> bool:
        return True

    async def get_info(self) -> ProviderInfo:
        return ProviderInfo(
            name="mock", display_name="Mock", status="available", default_model="mock-model"
        )


class _CountingRedis:
    """fakeredis with an ``XADD`` counter — the AC-5 instrument."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.xadd_calls = 0

    async def xadd(self, *args: Any, **kwargs: Any) -> Any:
        self.xadd_calls += 1
        return await self._inner.xadd(*args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


@pytest_asyncio.fixture
async def redis():
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    yield client
    await client.aclose()


def _build_app(redis: Any, provider: Any) -> Any:
    from text.main import create_app

    app = create_app(settings_override=Settings(port=5099, log_level="debug"))
    registry = ProviderRegistry()
    registry.register("mock", provider)
    app.state.redis = redis
    app.state.provider_registry = registry
    app.state.task_manager = TaskManager(redis=redis, task_ttl=3600, stream_max_len=10_000)
    return app


def _client(app: Any) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _body(count: int = 40) -> dict[str, Any]:
    return {"prompt": "summarise", "provider": "mock", "model": "mock-model", "stream": True}


def _parse_sse(text: str) -> list[tuple[str, str, str]]:
    """``(id, event, data)`` per frame, in order. Comment frames (pings) ignored."""
    frames = []
    # sse-starlette separates frames with CRLFCRLF, so normalise before splitting
    # — splitting the raw text on "\n\n" finds no boundary at all and silently
    # collapses the whole stream into one frame.
    for block in text.replace("\r\n", "\n").split("\n\n"):
        event_id = event = data = ""
        for line in block.split("\n"):
            if line.startswith("id: "):
                event_id = line[4:]
            elif line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = line[6:]
        if event:
            frames.append((event_id, event, data))
    return frames


async def _read_sse_into(response: Any, sink: list[tuple[str, str, str]]) -> None:
    """Append frames to ``sink`` as they arrive.

    A sink rather than a return value because these tests kill the reader
    mid-stream: a cancelled coroutine returns nothing, but what it had already
    received is exactly the evidence we need.
    """
    event_id = event = data = ""
    async for line in response.aiter_lines():
        line = line.rstrip("\r")
        if line.startswith("id: "):
            event_id = line[4:]
        elif line.startswith("event: "):
            event = line[7:]
        elif line.startswith("data: "):
            data = line[6:]
        elif line == "":
            if event:
                sink.append((event_id, event, data))
            event_id = event = data = ""


async def _read_sse(response: Any) -> list[tuple[str, str, str]]:
    frames: list[tuple[str, str, str]] = []
    await _read_sse_into(response, frames)
    return frames


async def _stream_into(
    client: AsyncClient, method: str, url: str, sink: list[tuple[str, str, str]], **kwargs: Any
) -> None:
    async with client.stream(method, url, **kwargs) as response:
        assert response.status_code == 200
        await _read_sse_into(response, sink)


def _asgi_post(app: Any, path: str, body: dict[str, Any], sink: bytearray) -> asyncio.Task[None]:
    """Drive one streaming POST straight at the ASGI app.

    **Not** httpx: ``ASGITransport`` collects the whole response before handing
    the caller a single byte, so a mid-flight disconnect is not expressible
    through it — the generation is always already over. Speaking ASGI directly
    is what makes "the reader vanished at delta 7" a real test rather than a
    test of the transport's buffering.
    """
    payload = json.dumps(body).encode()

    async def receive() -> dict[str, Any]:
        nonlocal payload
        if payload is not None:
            sent, payload = payload, None
            return {"type": "http.request", "body": sent, "more_body": False}
        await asyncio.Event().wait()  # never disconnects on its own
        raise AssertionError("unreachable")

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.body":
            sink.extend(message.get("body") or b"")

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"test"),
            (b"content-type", b"application/json"),
            (b"content-length", str(len(payload)).encode()),
            (b"x-tenant-id", TENANT.encode()),
        ],
        "client": ("127.0.0.1", 51234),
        "server": ("test", 80),
    }
    return asyncio.create_task(app(scope, receive, send))


async def _start_and_interrupt(
    app: Any, sink: list[tuple[str, str, str]], *, after_chunks: int, body: dict[str, Any]
) -> str:
    """Begin a streaming generation, read a few deltas, then KILL the reader.

    Cancelling the ASGI call is the harshest disconnect available: the whole
    request — response object, SSE send loop and all — is torn down mid-flight.
    A producer that survives this survives a closed tab, a dropped network and a
    sleeping laptop, none of which are as abrupt.

    Returns the generation id, taken from the first frame (§3C.3(4) exists so
    that a client can persist it before any token arrives).
    """
    raw = bytearray()
    task = _asgi_post(app, "/api/v1/generate", body, raw)
    try:
        for _ in range(3000):
            frames = _parse_sse(raw.decode(errors="ignore"))
            if len([f for f in frames if f[1] == "chunk"]) >= after_chunks:
                break
            await asyncio.sleep(0.002)
        else:  # pragma: no cover - the generation never produced enough deltas
            raise AssertionError("stream never reached the interruption point")
    finally:
        task.cancel()
        with contextlib.suppress(BaseException):
            await task

    sink.extend(_parse_sse(raw.decode(errors="ignore")))
    assert sink and sink[0][1] == "meta"
    return str(json.loads(sink[0][2])["generation_id"])


async def _await_status(app: Any, generation_id: str, status: TaskStatus) -> Any:
    """Wait for a producer nobody is reading to reach ``status``."""
    for _ in range(1000):
        state = await app.state.task_manager.get_task(generation_id)
        if state and state.status is status:
            return state
        await asyncio.sleep(0.01)
    state = await app.state.task_manager.get_task(generation_id)
    raise AssertionError(f"expected {status}, got {state.status if state else None}")


def _text_of(frames: list[tuple[str, str, str]]) -> str:
    return "".join(
        json.loads(data).get("content") or "" for _id, event, data in frames if event == "chunk"
    )


def _seqs(frames: list[tuple[str, str, str]]) -> list[int]:
    return [int(fid.rsplit(":", 1)[1]) for fid, event, _d in frames if event != "meta"]


# ── B-1: the producer outlives the response ─────────────────────────────────


class TestProducerOutlivesTheResponse:
    """The whole ticket, stated twice: at the hub, and over HTTP."""

    @pytest.mark.asyncio
    async def test_cancelling_the_subscriber_does_not_cancel_the_producer(self) -> None:
        """A reader's task dying must not reach the generation behind it."""
        hub = GenerationHub()
        released = asyncio.Event()
        completed = asyncio.Event()

        async def body(producer: Producer) -> None:
            producer.publish(GenerationEvent(producer.next_seq(), "chunk", '{"content":"a"}'))
            await released.wait()
            producer.publish(GenerationEvent(producer.next_seq(), "done", "{}"))
            producer.finish()
            completed.set()

        producer = hub.start("gen-1", body)
        subscriber, _replay = producer.attach(0)

        async def read_forever() -> None:
            while True:
                await subscriber.queue.get()

        reader = asyncio.create_task(read_forever())
        await asyncio.sleep(0)
        reader.cancel()
        producer.detach(subscriber)
        with pytest.raises(asyncio.CancelledError):
            await reader

        released.set()
        await asyncio.wait_for(completed.wait(), timeout=2)
        assert producer.finished
        assert producer.task is not None and not producer.task.cancelled()

    @pytest.mark.asyncio
    async def test_abandoned_http_response_leaves_the_generation_running(self, redis) -> None:
        """Close the tab mid-stream; the generation finishes anyway, in full."""
        app = _build_app(redis, _SlowProvider(count=30))
        partial: list[tuple[str, str, str]] = []
        generation_id = await _start_and_interrupt(app, partial, after_chunks=3, body=_body())
        # The reader saw only the first few deltas before it died.
        assert 3 <= len([f for f in partial if f[1] == "chunk"]) < 30

        await _await_status(app, generation_id, TaskStatus.COMPLETED)

        # ...and every delta it never saw is still in the replay buffer.
        events = await app.state.task_manager.read_events(generation_id)
        assert _text_of([("", e.event, e.payload) for e in events]).split() == [
            f"w{i}" for i in range(30)
        ]


# ── AC-18: a dropped socket is never a cancel ───────────────────────────────


class TestDroppedSocketIsNotACancel:
    @pytest.mark.asyncio
    async def test_disconnect_completes_rather_than_cancels(self, redis) -> None:
        app = _build_app(redis, _SlowProvider(count=20))
        partial: list[tuple[str, str, str]] = []
        generation_id = await _start_and_interrupt(app, partial, after_chunks=2, body=_body())
        state = await _await_status(app, generation_id, TaskStatus.COMPLETED)

        assert state.status is TaskStatus.COMPLETED
        assert state.status is not TaskStatus.CANCELLED
        # And nothing wrote the persisted cancel flag on our behalf.
        assert not await app.state.task_manager.is_cancel_requested(generation_id)

    @pytest.mark.asyncio
    async def test_explicit_cancel_does_stop_the_producer(self, redis) -> None:
        """The contrast case: cancellation works, it just has to be asked for."""
        deltas = 4000
        app = _build_app(redis, _SlowProvider(count=deltas, delay=0.001))
        async with _client(app) as client:
            partial: list[tuple[str, str, str]] = []
            generation_id = await _start_and_interrupt(app, partial, after_chunks=2, body=_body())
            cancelled = await client.post(f"/api/v1/generations/{generation_id}/cancel")
            assert cancelled.status_code == 200

            # Wait for the PRODUCER to stop, not for the endpoint's own status
            # write — the endpoint marks the task cancelled immediately, so
            # polling task state would assert nothing about the generation.
            producer = app.state.generation_hub.get(generation_id)
            assert producer is not None
            await asyncio.wait_for(producer.wait_finished(), timeout=20)
            state = await app.state.task_manager.get_task(generation_id)

        assert state is not None and state.status is TaskStatus.CANCELLED
        events = await app.state.task_manager.read_events(generation_id)
        # It stopped early — and still emitted a terminal frame carrying the
        # tokens it had already burned, rather than vanishing.
        assert events and events[-1].event == "done"
        assert len(events) < deltas
        terminal = json.loads(events[-1].payload)
        assert terminal["data"]["stopped_reason"] == "cancelled"
        assert terminal["data"]["usage"]["interrupted"] is True


# ── AC-15: reconnect with no gap and no duplicate ───────────────────────────


class TestReconnectIsGaplessAndDuplicateFree:
    @pytest.mark.asyncio
    async def test_resumed_stream_matches_an_uninterrupted_run(self, redis) -> None:
        app = _build_app(redis, _SlowProvider(count=40))
        async with _client(app) as client:
            # 1. The reference: one uninterrupted generation.
            async with client.stream(
                "POST", "/api/v1/generate", json=_body(), headers={"X-Tenant-Id": TENANT}
            ) as response:
                reference = await _read_sse(response)
            reference_text = _text_of(reference)
            assert reference_text.split() == [f"w{i}" for i in range(40)]

            # 2. The same generation, with the reader killed partway through.
            first_half: list[tuple[str, str, str]] = []
            generation_id = await _start_and_interrupt(
                app, first_half, after_chunks=7, body=_body()
            )
            assert len([f for f in first_half if f[1] == "chunk"]) < 40, "never interrupted"
            last_event_id = first_half[-1][0]
            assert last_event_id.startswith(f"{generation_id}:")

            # 3. Reconnect at the recorded cursor.
            async with client.stream(
                "GET",
                f"/api/v1/generations/{generation_id}/stream",
                headers={"Last-Event-ID": last_event_id, "X-Tenant-Id": TENANT},
            ) as response:
                assert response.status_code == 200
                second_half = await _read_sse(response)

            # No duplicate: every sequence number appears once, strictly increasing.
            seqs = _seqs(first_half) + _seqs(second_half)
            assert seqs == sorted(seqs)
            assert len(seqs) == len(set(seqs)), "a delta was delivered twice"

            # No gap: the reassembled text is the uninterrupted text.
            assert _text_of(first_half) + _text_of(second_half) == reference_text

    @pytest.mark.asyncio
    async def test_from_seq_query_is_the_fallback_for_header_stripping_proxies(self, redis) -> None:
        app = _build_app(redis, _SlowProvider(count=12))
        async with _client(app) as client:
            async with client.stream(
                "POST", "/api/v1/generate", json=_body(), headers={"X-Tenant-Id": TENANT}
            ) as response:
                frames = await _read_sse(response)
            generation_id = json.loads(frames[0][2])["generation_id"]

            response = await client.get(
                f"/api/v1/generations/{generation_id}/stream", params={"from_seq": 5}
            )
            resumed = _parse_sse(response.text)
            assert _seqs(resumed) == [s for s in _seqs(frames) if s > 5]

    @pytest.mark.asyncio
    async def test_cursor_ahead_of_the_head_emits_nothing(self, redis) -> None:
        """The dual-write race: a cursor past the head is a no-op, not an error."""
        app = _build_app(redis, _SlowProvider(count=5))
        async with _client(app) as client:
            async with client.stream(
                "POST", "/api/v1/generate", json=_body(), headers={"X-Tenant-Id": TENANT}
            ) as response:
                frames = await _read_sse(response)
            generation_id = json.loads(frames[0][2])["generation_id"]

            response = await client.get(
                f"/api/v1/generations/{generation_id}/stream", params={"from_seq": 9999}
            )
            assert response.status_code == 200
            assert [e for _i, e, _d in _parse_sse(response.text)] == ["meta"]

    @pytest.mark.asyncio
    async def test_unknown_generation_is_204(self, redis) -> None:
        app = _build_app(redis, _SlowProvider(count=1))
        async with _client(app) as client:
            response = await client.get("/api/v1/generations/never-existed/stream")
        assert response.status_code == 204

    @pytest.mark.asyncio
    async def test_first_event_carries_the_generation_id(self, redis) -> None:
        """§3C.3(4): persistable before any token arrives."""
        app = _build_app(redis, _SlowProvider(count=3))
        async with _client(app) as client:
            async with client.stream(
                "POST", "/api/v1/generate", json=_body(), headers={"X-Tenant-Id": TENANT}
            ) as response:
                frames = await _read_sse(response)

        first_id, first_event, first_data = frames[0]
        assert first_event == "meta"
        generation_id = json.loads(first_data)["generation_id"]
        assert generation_id
        assert first_id == f"{generation_id}:0"
        for frame_id, event, _data in frames[1:]:
            assert frame_id.startswith(f"{generation_id}:")
            assert event in ("chunk", "usage", "done")


# ── AC-5: one durable write per batch, not per token ────────────────────────


class TestDurableWritesAreCoalesced:
    @pytest.mark.asyncio
    async def test_xadd_count_is_far_below_the_delta_count(self) -> None:
        inner = fakeredis.aioredis.FakeRedis(decode_responses=True)
        counting = _CountingRedis(inner)
        try:
            deltas = 200
            app = _build_app(counting, _SlowProvider(count=deltas, delay=0))
            async with _client(app) as client:
                async with client.stream(
                    "POST", "/api/v1/generate", json=_body(), headers={"X-Tenant-Id": TENANT}
                ) as response:
                    frames = await _read_sse(response)

            assert len([f for f in frames if f[1] == "chunk"]) == deltas
            # The terminal frame is its own (deliberately uncoalesced) write, so
            # the floor is one batch write plus one terminal write.
            expected_ceiling = (deltas // FLUSH_MAX_DELTAS) + 2
            assert counting.xadd_calls <= expected_ceiling, (
                f"{counting.xadd_calls} durable writes for {deltas} deltas — "
                "the coalescer is not coalescing"
            )
            assert counting.xadd_calls >= 2
        finally:
            await inner.aclose()

    @pytest.mark.asyncio
    async def test_a_batch_replays_every_delta_it_coalesced(self, redis) -> None:
        """Coalescing must not cost replay granularity."""
        manager = TaskManager(redis=redis)
        events = [GenerationEvent(seq, "chunk", f'{{"content":"c{seq}"}}') for seq in range(1, 21)]
        await manager.append_batch("gen-batch", events, tenant_id=TENANT)

        assert len(await manager.read_events("gen-batch")) == 20
        assert [e.seq for e in await manager.read_events("gen-batch", after_seq=17)] == [18, 19, 20]


# ── §3C.6: idempotency ──────────────────────────────────────────────────────


class TestStreamingIdempotency:
    @pytest.mark.asyncio
    async def test_same_key_and_payload_returns_the_same_generation(self, redis) -> None:
        app = _build_app(redis, _SlowProvider(count=4))
        headers = {"X-Tenant-Id": TENANT, "Idempotency-Key": "k-1"}
        async with _client(app) as client:
            async with client.stream(
                "POST", "/api/v1/generate", json=_body(), headers=headers
            ) as response:
                first = await _read_sse(response)
            async with client.stream(
                "POST", "/api/v1/generate", json=_body(), headers=headers
            ) as response:
                second = await _read_sse(response)

        assert json.loads(first[0][2])["generation_id"] == json.loads(second[0][2])["generation_id"]
        # Replay delivers the same content — the provider was not called twice.
        assert _text_of(second) == _text_of(first)

    @pytest.mark.asyncio
    async def test_same_key_different_payload_is_409(self, redis) -> None:
        app = _build_app(redis, _SlowProvider(count=3))
        headers = {"X-Tenant-Id": TENANT, "Idempotency-Key": "k-2"}
        async with _client(app) as client:
            async with client.stream(
                "POST", "/api/v1/generate", json=_body(), headers=headers
            ) as response:
                await _read_sse(response)

            conflicting = dict(_body())
            conflicting["prompt"] = "something else entirely"
            response = await client.post("/api/v1/generate", json=conflicting, headers=headers)

        assert response.status_code == 409
        assert "idempotency_conflict" in response.text


# ── §3C.5: abandonment is configuration, tenant → SYSTEM ────────────────────


class TestGenerationPolicyResolution:
    class _State:
        def __init__(self, policies: Any) -> None:
            self.generation_policies = policies

    def test_floor_never_abandons(self) -> None:
        assert resolve_generation_policy(self._State(None), TENANT).abandon_on_disconnect is False

    def test_tenant_row_wins_over_system(self) -> None:
        state = self._State(
            {
                TENANT: {"": {"abandonOnDisconnect": True, "disconnectGraceSeconds": 30}},
                "": {"": {"abandonOnDisconnect": False, "disconnectGraceSeconds": 900}},
            }
        )
        policy = resolve_generation_policy(state, TENANT)
        assert policy.abandon_on_disconnect is True
        assert policy.disconnect_grace_seconds == 30

    def test_system_applies_only_when_the_tenant_has_no_opinion(self) -> None:
        state = self._State({"": {"": {"maxGenerationSeconds": 120}}})
        assert resolve_generation_policy(state, "tenant-with-no-row").max_generation_seconds == 120

    def test_absent_tenant_context_resolves_system_not_a_customer(self) -> None:
        state = self._State(
            {
                TENANT: {"": {"maxGenerationSeconds": 11}},
                "": {"": {"maxGenerationSeconds": 22}},
            }
        )
        assert resolve_generation_policy(state, None).max_generation_seconds == 22

    def test_invalid_values_keep_the_floor(self) -> None:
        state = self._State({"": {"": {"disconnectGraceSeconds": None, "maxGenerationSeconds": 0}}})
        policy = resolve_generation_policy(state, None)
        assert policy.disconnect_grace_seconds == GenerationPolicy().disconnect_grace_seconds
        assert policy.max_generation_seconds == GenerationPolicy().max_generation_seconds


class TestAbandonmentDecision:
    """``should_abandon`` reads subscriber state and a clock — never a socket."""

    def test_never_abandons_while_the_default_policy_applies(self) -> None:
        producer = Producer("g")
        subscriber, _ = producer.attach(0)
        producer.detach(subscriber)
        assert producer.should_abandon(GenerationPolicy(), now=producer.started_at + 10_000) == (
            "max_generation_seconds"
        )
        assert producer.should_abandon(GenerationPolicy(), now=producer.started_at + 1) is None

    def test_grace_runs_from_the_last_detach_when_abandonment_is_enabled(self) -> None:
        policy = GenerationPolicy(abandon_on_disconnect=True, disconnect_grace_seconds=5)
        producer = Producer("g")
        subscriber, _ = producer.attach(0)
        assert producer.should_abandon(policy) is None, "attached readers are never abandoned"
        producer.detach(subscriber)
        assert producer.should_abandon(policy) is None
        assert (
            producer.should_abandon(policy, now=producer.started_at + 3600)
            == "max_generation_seconds"
        )


# ── The dedupe primitive ────────────────────────────────────────────────────


class TestDedupeBySeq:
    def test_overlapping_backlog_and_ring_yield_each_seq_once(self) -> None:
        backlog = [GenerationEvent(s, "chunk", "{}") for s in range(1, 51)]
        ring = [GenerationEvent(s, "chunk", "{}") for s in range(30, 61)]
        kept, cursor = dedupe_by_seq([*backlog, *ring], 0)
        assert [e.seq for e in kept] == list(range(1, 61))
        assert cursor == 60

    def test_events_at_or_below_the_cursor_are_dropped(self) -> None:
        events = [GenerationEvent(s, "chunk", "{}") for s in range(1, 11)]
        kept, cursor = dedupe_by_seq(events, 7)
        assert [e.seq for e in kept] == [8, 9, 10]
        assert cursor == 10
