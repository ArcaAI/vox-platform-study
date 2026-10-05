"""TASK-1045 AB-STT — the per-session segment outbox.

Every FINAL a streaming session produces is posted to the gateway's
``POST internal/stt/segments`` in batches: at most 25 segments per batch, or
whatever is pending once 1500 ms have passed since the oldest unsent final, and
IMMEDIATELY on pause / finalize. A transient gateway failure parks the batch in
the shared Redis outbox (the transcript outbox's redrive pattern: lease,
attempts, delete only after a confirmed 2xx); a permanent 4xx is dropped.
Idempotent by ``utteranceIndex``: a final seen twice is sent once.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock

from stt.core.exceptions import APIGatewayError
from stt.streaming.schemas import SegmentResult


class _FakeRedis:
    """Dict-backed stand-in for the three hash commands the outbox uses."""

    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}

    async def hset(self, key: str, field: str, value: str) -> int:
        self.hashes.setdefault(key, {})[field] = value
        return 1

    async def hgetall(self, key: str) -> dict[str, str]:
        return dict(self.hashes.get(key, {}))

    async def hdel(self, key: str, *fields: str) -> int:
        bucket = self.hashes.get(key, {})
        return sum(1 for f in fields if bucket.pop(f, None) is not None)


def _final(index: int, text: str = "hello", **kw: Any) -> SegmentResult:
    return SegmentResult(
        text=text,
        is_final=True,
        utterance_index=index,
        start_time=kw.pop("start", index * 1.0),
        end_time=kw.pop("end", index * 1.0 + 0.75),
        **kw,
    )


def _outbox(post: Any, redis: Any = None, **kw: Any):
    from stt.streaming.segment_outbox import SegmentOutbox

    return SegmentOutbox(
        redis=redis if redis is not None else _FakeRedis(),
        session_id="sess-1",
        tenant_id="tenant-1",
        consultation_id="cons-1",
        post=post,
        audio_offset_ms=kw.pop("audio_offset_ms", lambda: 12_345),
        **kw,
    )


def _transient() -> APIGatewayError:
    return APIGatewayError("boom", details={"status_code": 503})


def _permanent() -> APIGatewayError:
    return APIGatewayError("bad", details={"status_code": 400})


class TestBatching:
    async def test_full_batch_of_25_is_posted_without_waiting_for_the_interval(self):
        post = AsyncMock(return_value={"accepted": 25})
        box = _outbox(post, flush_interval_s=30.0)
        for i in range(25):
            box.add(_final(i))
        await asyncio.sleep(0.05)
        assert post.await_count == 1
        body = post.await_args.args[0]
        assert [s["utteranceIndex"] for s in body["segments"]] == list(range(25))
        await box.close()

    async def test_a_batch_never_carries_more_than_25_segments(self):
        post = AsyncMock(return_value={})
        box = _outbox(post, flush_interval_s=30.0)
        for i in range(30):
            box.add(_final(i))
        await box.flush()
        sizes = [len(c.args[0]["segments"]) for c in post.await_args_list]
        assert sizes == [25, 5]
        await box.close()

    async def test_partial_batch_waits_for_the_interval_then_posts(self):
        post = AsyncMock(return_value={})
        box = _outbox(post, flush_interval_s=0.1)
        box.add(_final(0))
        box.add(_final(1))
        await asyncio.sleep(0.03)
        assert post.await_count == 0, "below 25 the batch must wait for the interval"
        await asyncio.sleep(0.2)
        assert post.await_count == 1
        assert len(post.await_args.args[0]["segments"]) == 2
        await box.close()

    async def test_flush_posts_immediately_and_is_a_noop_when_empty(self):
        post = AsyncMock(return_value={})
        box = _outbox(post, flush_interval_s=30.0)
        await box.flush()
        assert post.await_count == 0
        box.add(_final(0))
        await box.flush()
        assert post.await_count == 1
        assert box.pending_count == 0
        await box.close()


class TestPayload:
    async def test_body_shape_matches_the_internal_segments_contract(self):
        post = AsyncMock(return_value={})
        box = _outbox(post, audio_offset_ms=lambda: 61_000)
        box.add(
            _final(7, "chest pain", start=60.25, end=61.5, speaker_id="SPEAKER_1", language="en")
        )
        box.add(_final(8, "since monday", start=61.5, end=62.0))
        await box.flush()

        body = post.await_args.args[0]
        assert set(body) == {
            "tenantId",
            "consultationId",
            "sttSessionId",
            "audioOffsetMs",
            "segments",
        }
        assert body["tenantId"] == "tenant-1"
        assert body["consultationId"] == "cons-1"
        assert body["sttSessionId"] == "sess-1"
        assert body["audioOffsetMs"] == 61_000
        first, second = body["segments"]
        assert first["utteranceIndex"] == 7
        assert first["text"] == "chest pain"
        assert first["startMs"] == 60_250
        assert first["endMs"] == 61_500
        assert first["speaker"] == "SPEAKER_1"
        assert first["language"] == "en"
        assert isinstance(first["capturedAt"], str) and first["capturedAt"].endswith("Z")
        # Optional keys are omitted, never null.
        assert "speaker" not in second and "language" not in second
        await box.close()

    async def test_same_utterance_index_is_sent_once(self):
        post = AsyncMock(return_value={})
        box = _outbox(post)
        box.add(_final(3))
        box.add(_final(3))
        await box.flush()
        box.add(_final(3))  # a late re-add after the batch went out
        await box.flush()
        sent = [s["utteranceIndex"] for c in post.await_args_list for s in c.args[0]["segments"]]
        assert sent == [3]
        await box.close()

    async def test_partials_and_empty_finals_are_ignored(self):
        post = AsyncMock(return_value={})
        box = _outbox(post)
        box.add(SegmentResult(text="interim", is_final=False, utterance_index=0))
        box.add(_final(1, "   "))
        await box.flush()
        assert post.await_count == 0
        await box.close()


class TestRedrive:
    async def test_transient_failure_parks_the_batch_and_the_drain_redrives_it(self):
        from stt.streaming.segment_outbox import SEGMENT_OUTBOX_KEY, drain_segment_outbox

        redis = _FakeRedis()
        post = AsyncMock(side_effect=_transient())
        box = _outbox(post, redis=redis)
        box.add(_final(0))
        box.add(_final(1))
        await box.flush()

        parked = redis.hashes[SEGMENT_OUTBOX_KEY]
        assert len(parked) == 1
        entry = json.loads(next(iter(parked.values())))
        assert [s["utteranceIndex"] for s in entry["body"]["segments"]] == [0, 1]

        redrive_post = AsyncMock(return_value={"accepted": 2})
        drained = await drain_segment_outbox(redis, redrive_post, worker_id="w1", max_attempts=10)
        assert drained == 1
        assert redrive_post.await_args.args[0] == entry["body"]
        assert redis.hashes[SEGMENT_OUTBOX_KEY] == {}
        await box.close()

    async def test_permanent_4xx_is_dropped_not_parked(self):
        from stt.streaming.segment_outbox import SEGMENT_OUTBOX_KEY

        redis = _FakeRedis()
        box = _outbox(AsyncMock(side_effect=_permanent()), redis=redis)
        box.add(_final(0))
        await box.flush()
        assert redis.hashes.get(SEGMENT_OUTBOX_KEY, {}) == {}
        await box.close()

    async def test_redrive_keeps_a_transient_failure_and_drops_when_exhausted(self):
        from stt.streaming.segment_outbox import SEGMENT_OUTBOX_KEY, drain_segment_outbox

        redis = _FakeRedis()
        box = _outbox(AsyncMock(side_effect=_transient()), redis=redis)
        box.add(_final(0))
        await box.flush()

        failing = AsyncMock(side_effect=_transient())
        await drain_segment_outbox(redis, failing, worker_id="w1", max_attempts=2)
        (raw,) = redis.hashes[SEGMENT_OUTBOX_KEY].values()
        assert json.loads(raw)["attempts"] == 1
        await drain_segment_outbox(redis, failing, worker_id="w1", max_attempts=2)
        assert redis.hashes[SEGMENT_OUTBOX_KEY] == {}
        await box.close()

    async def test_close_redrives_its_own_parked_batches_before_returning(self):
        from stt.streaming.segment_outbox import SEGMENT_OUTBOX_KEY

        redis = _FakeRedis()
        post = AsyncMock(side_effect=[_transient(), _transient(), {"accepted": 1}])
        box = _outbox(post, redis=redis, inline_attempts=2)
        box.add(_final(0))
        await box.flush()
        assert len(redis.hashes[SEGMENT_OUTBOX_KEY]) == 1
        await box.close()
        assert redis.hashes[SEGMENT_OUTBOX_KEY] == {}


class TestGatewayClient:
    async def test_post_stt_segments_targets_the_internal_route_with_tenant_addressing(self):
        from stt.core.api_client.gateway import APIGatewayClient

        client = APIGatewayClient(base_url="http://gw/api/v1", api_key="k")
        client._request = AsyncMock(return_value={"accepted": 1})  # type: ignore[method-assign]
        body = {"tenantId": "tenant-1", "segments": []}
        await client.post_stt_segments(body)
        args, kwargs = client._request.await_args
        assert args == ("POST", "/internal/stt/segments")
        assert kwargs["json"] == body
        assert kwargs["headers"] == {"X-Internal-Tenant-Id": "tenant-1"}
