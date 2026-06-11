"""Unit tests for Redis audio-stream hygiene (TASK-351 P1-3).

Covers:
- ``SessionMetadata.last_stream_id`` — additive persisted field
- ``IngestionConsumer`` ``on_batch`` callback — fires with the last
  processed stream entry ID per batch
- ``SessionManager._make_batch_handler`` — persists ``last_stream_id``
  into the session hash and periodically ``XTRIM MINID``s the consumed
  portion of ``stt:audio:{sid}``
- ``_recover_sessions`` — resumes ``XREAD`` from the stored entry ID
  instead of replaying from ``0-0``; first start still reads from the
  beginning
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from stt_v2.streaming.schemas import SessionMetadata, SessionStatus

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_profile(max_streams: int = 10):
    from stt_v2.streaming.execution_profile import ExecutionProfile, PlatformType

    return ExecutionProfile(
        platform=PlatformType.CPU,
        device_name="cpu-test",
        gpu_count=0,
        total_vram_gb=0,
        total_ram_gb=16,
        cpu_cores=4,
        asr_device="cpu",
        asr_compute_type="float32",
        asr_max_batch_size=2,
        asr_model_quantization="fp16",
        embedding_device="cpu",
        embedding_batch_size=2,
        preprocess_pool_size=2,
        denoise_enabled_default=False,
        max_concurrent_streams=max_streams,
        batch_scheduler_max_wait_ms=500,
        vad_silence_threshold_ms=700,
        multi_gpu_strategy="none",
    )


def _make_manager():
    from stt_v2.streaming.session_manager import SessionManager

    redis_mock = AsyncMock()
    redis_mock.scan = AsyncMock(return_value=(0, []))
    mgr = SessionManager(redis=redis_mock, profile=_make_profile(), worker_id="test-worker")
    return mgr


def _frame_fields() -> dict[bytes, bytes]:
    return {
        b"seq": b"1",
        b"sr": b"16000",
        b"enc": b"pcm_s16le",
        b"ch": b"1",
        b"data": b"\x00\x00" * 160,
        b"final": b"0",
        b"ts": b"1000.0",
    }


# ---------------------------------------------------------------------------
# SessionMetadata.last_stream_id
# ---------------------------------------------------------------------------


class TestSessionMetadataLastStreamId:
    def test_default_is_none_and_omitted(self):
        meta = SessionMetadata(session_id="s1", tenant_id="t1", pipeline_id="p1")
        assert meta.last_stream_id is None
        assert "last_stream_id" not in meta.to_redis_dict()

    def test_roundtrip(self):
        meta = SessionMetadata(
            session_id="s1",
            tenant_id="t1",
            pipeline_id="p1",
            last_stream_id="1718000000000-5",
        )
        d = meta.to_redis_dict()
        assert d["last_stream_id"] == "1718000000000-5"
        restored = SessionMetadata.from_redis_dict(d)
        assert restored.last_stream_id == "1718000000000-5"

    def test_roundtrip_absent(self):
        meta = SessionMetadata(session_id="s1", tenant_id="t1", pipeline_id="p1")
        restored = SessionMetadata.from_redis_dict(meta.to_redis_dict())
        assert restored.last_stream_id is None


# ---------------------------------------------------------------------------
# IngestionConsumer on_batch callback
# ---------------------------------------------------------------------------


class TestIngestionConsumerOnBatch:
    @pytest.mark.asyncio
    async def test_on_batch_called_with_last_entry_id(self):
        from stt_v2.streaming.redis_streams import IngestionConsumer

        redis_mock = AsyncMock()
        call_count = 0

        async def fake_xread(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return [[
                    b"stt:audio:s1",
                    [(b"1-0", _frame_fields()), (b"2-0", _frame_fields())],
                ]]
            await asyncio.sleep(0.05)
            return []

        redis_mock.xread.side_effect = fake_xread

        batch_ids: list[str] = []

        async def on_batch(last_id: str) -> None:
            batch_ids.append(last_id)

        consumer = IngestionConsumer(
            redis=redis_mock,
            session_id="s1",
            on_frame=AsyncMock(),
            on_batch=on_batch,
            block_ms=50,
        )
        await consumer.start()
        await asyncio.sleep(0.2)
        await consumer.stop()

        assert batch_ids == ["2-0"]

    @pytest.mark.asyncio
    async def test_on_batch_error_does_not_kill_consumer(self):
        from stt_v2.streaming.redis_streams import IngestionConsumer

        redis_mock = AsyncMock()
        call_count = 0

        async def fake_xread(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                return [[b"stt:audio:s1", [(f"{call_count}-0".encode(), _frame_fields())]]]
            await asyncio.sleep(0.05)
            return []

        redis_mock.xread.side_effect = fake_xread

        on_batch = AsyncMock(side_effect=RuntimeError("boom"))
        frames = []

        async def on_frame(frame):
            frames.append(frame)

        consumer = IngestionConsumer(
            redis=redis_mock,
            session_id="s1",
            on_frame=on_frame,
            on_batch=on_batch,
            block_ms=50,
        )
        await consumer.start()
        await asyncio.sleep(0.25)
        await consumer.stop()

        # Both batches processed despite the failing callback
        assert len(frames) == 2
        assert on_batch.await_count == 2

    @pytest.mark.asyncio
    async def test_no_on_batch_keeps_existing_behavior(self):
        from stt_v2.streaming.redis_streams import IngestionConsumer

        redis_mock = AsyncMock()
        call_count = 0

        async def fake_xread(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return [[b"stt:audio:s1", [(b"1-0", _frame_fields())]]]
            await asyncio.sleep(0.05)
            return []

        redis_mock.xread.side_effect = fake_xread

        frames = []

        async def on_frame(frame):
            frames.append(frame)

        consumer = IngestionConsumer(
            redis=redis_mock, session_id="s1", on_frame=on_frame, block_ms=50
        )
        await consumer.start()
        await asyncio.sleep(0.15)
        await consumer.stop()

        assert len(frames) == 1


# ---------------------------------------------------------------------------
# SessionManager._make_batch_handler — persist + trim
# ---------------------------------------------------------------------------


class TestBatchHandler:
    def _make_session(self, mgr, session_id: str = "s1"):
        from stt_v2.streaming.session import StreamSession

        meta = SessionMetadata(
            session_id=session_id, tenant_id="t1", pipeline_id="p1",
        )
        return StreamSession(metadata=meta, redis=mgr._redis)

    @pytest.mark.asyncio
    async def test_persists_last_stream_id_per_batch(self):
        mgr = _make_manager()
        session = self._make_session(mgr)
        handler = mgr._make_batch_handler(session)

        await handler("5-0")

        assert session.metadata.last_stream_id == "5-0"
        mgr._redis.hset.assert_any_await("stt:session:s1", "last_stream_id", "5-0")

    @pytest.mark.asyncio
    async def test_trims_audio_stream_with_minid(self):
        mgr = _make_manager()
        mgr._audio_trim_interval_s = 30.0
        mgr._last_audio_trim_at.clear()
        session = self._make_session(mgr)
        handler = mgr._make_batch_handler(session)

        await handler("7-0")

        mgr._redis.xtrim.assert_awaited_once_with(
            "stt:audio:s1", minid="7-0", approximate=True
        )

    @pytest.mark.asyncio
    async def test_trim_throttled_by_interval(self):
        mgr = _make_manager()
        mgr._audio_trim_interval_s = 3600.0  # long interval
        mgr._last_audio_trim_at.clear()
        session = self._make_session(mgr)
        handler = mgr._make_batch_handler(session)

        await handler("7-0")
        await handler("8-0")
        await handler("9-0")

        # Only the first call within the interval performs a trim,
        # but every batch persists last_stream_id.
        assert mgr._redis.xtrim.await_count == 1
        assert session.metadata.last_stream_id == "9-0"

    @pytest.mark.asyncio
    async def test_trim_disabled_when_interval_zero(self):
        mgr = _make_manager()
        mgr._audio_trim_interval_s = 0.0
        session = self._make_session(mgr)
        handler = mgr._make_batch_handler(session)

        await handler("7-0")

        mgr._redis.xtrim.assert_not_awaited()
        assert session.metadata.last_stream_id == "7-0"

    @pytest.mark.asyncio
    async def test_redis_errors_are_swallowed(self):
        mgr = _make_manager()
        mgr._audio_trim_interval_s = 30.0
        mgr._last_audio_trim_at.clear()
        mgr._redis.hset = AsyncMock(side_effect=RuntimeError("redis down"))
        mgr._redis.xtrim = AsyncMock(side_effect=RuntimeError("redis down"))
        session = self._make_session(mgr)
        handler = mgr._make_batch_handler(session)

        await handler("5-0")  # must not raise

        assert session.metadata.last_stream_id == "5-0"


# ---------------------------------------------------------------------------
# Recovery: resume from stored stream ID
# ---------------------------------------------------------------------------


class TestRecoveryResumeFromStoredId:
    def _arm_recovery(self, mgr, meta: SessionMetadata):
        redis_data = meta.to_redis_dict()
        mgr._redis.scan = AsyncMock(
            return_value=(0, [f"stt:session:{meta.session_id}".encode()])
        )
        mgr._redis.hgetall = AsyncMock(return_value=redis_data)
        mgr._redis.exists = AsyncMock(return_value=False)
        mgr._load_pipeline_config = AsyncMock(return_value=None)
        mgr._load_vad_service = AsyncMock(return_value=None)
        mgr._load_asr_pipeline = AsyncMock(return_value=(AsyncMock(), None))

    @pytest.mark.asyncio
    async def test_recovery_resumes_from_stored_stream_id(self):
        mgr = _make_manager()
        meta = SessionMetadata(
            session_id="rec-1",
            tenant_id="t1",
            pipeline_id="p1",
            status=SessionStatus.ACTIVE,
            worker_id="test-worker",
            last_stream_id="1718000000000-3",
        )
        self._arm_recovery(mgr, meta)

        with (
            patch("stt_v2.streaming.session_manager.IngestionConsumer") as MockConsumer,
            patch("stt_v2.streaming.session_manager.ControlListener") as MockListener,
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            MockConsumer.return_value = AsyncMock()
            MockListener.return_value = AsyncMock()

            await mgr._recover_sessions()

        assert "rec-1" in mgr._sessions
        assert MockConsumer.call_args.kwargs["last_id"] == "1718000000000-3"

    @pytest.mark.asyncio
    async def test_recovery_without_stored_id_reads_from_beginning(self):
        mgr = _make_manager()
        meta = SessionMetadata(
            session_id="rec-2",
            tenant_id="t1",
            pipeline_id="p1",
            status=SessionStatus.ACTIVE,
            worker_id="test-worker",
        )
        self._arm_recovery(mgr, meta)

        with (
            patch("stt_v2.streaming.session_manager.IngestionConsumer") as MockConsumer,
            patch("stt_v2.streaming.session_manager.ControlListener") as MockListener,
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            MockConsumer.return_value = AsyncMock()
            MockListener.return_value = AsyncMock()

            await mgr._recover_sessions()

        assert "rec-2" in mgr._sessions
        assert MockConsumer.call_args.kwargs["last_id"] == "0-0"

    @pytest.mark.asyncio
    async def test_create_session_starts_from_beginning_with_batch_handler(self):
        mgr = _make_manager()
        mgr._load_pipeline_config = AsyncMock(return_value=None)
        mgr._load_vad_service = AsyncMock(return_value=None)
        mgr._load_asr_pipeline = AsyncMock(return_value=(None, None))

        with (
            patch("stt_v2.streaming.session_manager.IngestionConsumer") as MockConsumer,
            patch("stt_v2.streaming.session_manager.ControlListener") as MockListener,
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            MockConsumer.return_value = AsyncMock()
            MockListener.return_value = AsyncMock()
            session = await mgr.create_session("s-new", "t1", "p1")

        assert session is not None
        # No last_id override — consumer defaults to "0-0" (read from start)
        assert "last_id" not in MockConsumer.call_args.kwargs
        # Batch handler wired so last_stream_id tracking starts immediately
        assert MockConsumer.call_args.kwargs["on_batch"] is not None

        await mgr.remove_session("s-new")
