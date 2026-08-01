"""TASK-597 lane B3 — finalize must publish the terminal ``closed`` status EARLY.

``closed`` is the terminal entry on the result stream: the gateway's Redis
subscription COMPLETES on it, and the SDK's ``stopAndDrain`` blocks until it
arrives. Publishing it only after the MinIO uploads + durable transcript
persistence meant every Stop click waited on server-side durability work — up to
the SDK's whole drain timeout on a slow blob store.

The order that must hold::

    drain (caller) -> last transcript -> status 'closed'
                   -> blob uploads -> dual capture -> durable transcript
                   -> session.close() -> remove_session()

These tests lock BOTH halves of that: nothing transcript-shaped may be published
after ``closed``, and none of the durability work may precede it. The durability
work itself must still run — this is "publish earlier", never "persist less".
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest


def _one_second_pcm(sample_rate: int = 16000) -> bytes:
    return b"\x00\x01" * sample_rate


def _make_session(
    session_id: str = "sess_finalize_order",
    tenant_id: str = "t1",
    consultation_id: str | None = "c1",
    sample_rate: int = 16000,
):
    from stt.streaming.schemas import SessionMetadata, SessionStatus
    from stt.streaming.session import StreamSession

    meta = SessionMetadata(
        session_id=session_id,
        tenant_id=tenant_id,
        pipeline_id="p1",
        consultation_id=consultation_id,
        status=SessionStatus.ACTIVE,
        sample_rate=sample_rate,
    )
    return StreamSession(metadata=meta, redis=AsyncMock(), persist_interval_s=5.0)


def _make_manager():
    from stt.streaming.execution_profile import ExecutionProfile, PlatformType
    from stt.streaming.session_manager import SessionManager

    profile = ExecutionProfile(
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
        max_concurrent_streams=10,
        batch_scheduler_max_wait_ms=500,
        vad_silence_threshold_ms=700,
        multi_gpu_strategy="none",
    )
    redis_mock = AsyncMock()
    redis_mock.scan = AsyncMock(return_value=(0, []))
    return SessionManager(redis=redis_mock, profile=profile, worker_id="test-worker")


def _instrument(mgr, session):
    """Wire a manager whose every finalize side effect appends to one ordered log."""
    order: list[str] = []

    publisher = MagicMock()

    async def _publish_status(status: str) -> str:
        order.append(f"status:{status}")
        return "0-1"

    async def _publish(result) -> str:  # noqa: ANN001 - test double
        order.append("transcript")
        return "0-2"

    publisher.publish_status = AsyncMock(side_effect=_publish_status)
    publisher.publish = AsyncMock(side_effect=_publish)
    mgr._publishers[session.session_id] = publisher

    def _upload(name: str, uri: str | None):
        async def _inner(**_kwargs):
            order.append(f"upload:{name}")
            return uri

        return AsyncMock(side_effect=_inner)

    blob = MagicMock()
    blob.upload_streaming_raw_chunk = _upload("raw_chunk", "s3://bucket/chunk")
    blob.upload_streaming_raw_complete = _upload("raw_complete", "s3://bucket/complete.wav")
    blob.upload_streaming_processed_complete = _upload("processed_complete", None)
    blob.upload_streaming_transcript = _upload("transcript_json", "s3://bucket/transcript.json")
    blob.upload_streaming_metadata = _upload("metadata_json", "s3://bucket/metadata.json")
    mgr._blob_service = blob

    async def _register_dual_capture(*_args, **_kwargs):
        order.append("register_dual_capture")

    async def _persist(*_args, **_kwargs):
        order.append("persist_streaming_transcript")

    mgr._register_dual_capture = AsyncMock(side_effect=_register_dual_capture)
    mgr._persist_streaming_transcript = AsyncMock(side_effect=_persist)

    original_close = session.close

    async def _close(**kwargs):
        order.append("session.close")
        return await original_close(**kwargs)

    session.close = _close  # type: ignore[method-assign]

    async def _remove(_session_id: str):
        order.append("remove_session")

    mgr.remove_session = AsyncMock(side_effect=_remove)

    return order, publisher, blob


class TestFinalizePublishesClosedBeforeDurabilityWork:
    @pytest.mark.asyncio
    async def test_closed_precedes_every_blob_upload(self):
        mgr = _make_manager()
        session = _make_session()
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)
        mgr._sessions[session.session_id] = session
        order, _publisher, blob = _instrument(mgr, session)

        await mgr._finalize_session(session)

        assert "status:closed" in order, order
        closed_at = order.index("status:closed")
        uploads = [i for i, step in enumerate(order) if step.startswith("upload:")]
        assert uploads, "expected the blob uploads to still run"
        assert min(uploads) > closed_at, order

        # The uploads themselves are unchanged — "publish earlier", not "upload less".
        blob.upload_streaming_raw_complete.assert_awaited_once()
        blob.upload_streaming_transcript.assert_awaited_once()
        blob.upload_streaming_metadata.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_closed_precedes_dual_capture_persist_close_and_removal(self):
        mgr = _make_manager()
        session = _make_session()
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)
        mgr._sessions[session.session_id] = session
        order, _publisher, _blob = _instrument(mgr, session)

        await mgr._finalize_session(session)

        closed_at = order.index("status:closed")
        for step in (
            "register_dual_capture",
            "persist_streaming_transcript",
            "session.close",
            "remove_session",
        ):
            assert step in order, (step, order)
            assert order.index(step) > closed_at, (step, order)

    @pytest.mark.asyncio
    async def test_closed_is_published_exactly_once(self):
        """The ``finally`` fallback must not double-publish the terminal status."""
        mgr = _make_manager()
        session = _make_session()
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)
        mgr._sessions[session.session_id] = session
        order, _publisher, _blob = _instrument(mgr, session)

        await mgr._finalize_session(session)

        assert order.count("status:closed") == 1, order
        assert order.count("status:finalizing") == 1, order
        assert order.index("status:finalizing") < order.index("status:closed"), order

    @pytest.mark.asyncio
    async def test_tail_transcript_still_precedes_closed(self):
        """The last final must reach the stream BEFORE the terminal status.

        Every finalize entrypoint drains the inference queue before entering
        finalize; this reproduces that with a drain double that publishes the
        tail final, and asserts the terminal status lands after it.
        """
        mgr = _make_manager()
        session = _make_session()
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)
        mgr._sessions[session.session_id] = session
        order, publisher, _blob = _instrument(mgr, session)

        async def _flush(session, preprocessor):  # noqa: ANN001 - test double
            return None

        async def _drain(session_id: str):
            await publisher.publish(MagicMock(text="tail final"))

        mgr._flush_final_utterance = _flush
        mgr._drain_inference_queue = _drain

        await mgr.end_session(session.session_id)

        assert order.index("transcript") < order.index("status:closed"), order

    @pytest.mark.asyncio
    async def test_in_flight_partial_is_cancelled_before_closed(self):
        """Nothing transcript-shaped may be emitted after the terminal status.

        A partial task is the only publisher that can still be in flight when
        finalize starts, so finalize cancels it before publishing ``closed``.
        """
        import asyncio

        mgr = _make_manager()
        session = _make_session()
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)
        mgr._sessions[session.session_id] = session
        order, publisher, _blob = _instrument(mgr, session)

        started = asyncio.Event()

        async def _late_partial():
            started.set()
            await asyncio.sleep(0.5)
            await publisher.publish(MagicMock(text="late partial"))

        task = asyncio.create_task(_late_partial())
        mgr._partial_tasks[session.session_id] = task
        await started.wait()

        await mgr._finalize_session(session)
        await asyncio.sleep(0)

        assert task.cancelled() or task.done()
        assert "transcript" not in order, order


class TestEarlyPublishFailureFallsBackToTheLatePublish:
    @pytest.mark.asyncio
    async def test_closed_is_republished_after_close_when_the_early_publish_raises(self):
        mgr = _make_manager()
        session = _make_session()
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)
        mgr._sessions[session.session_id] = session
        order, publisher, _blob = _instrument(mgr, session)

        calls = {"n": 0}

        async def _flaky_status(status: str) -> str:
            if status == "closed":
                calls["n"] += 1
                if calls["n"] == 1:
                    raise RuntimeError("redis down")
            order.append(f"status:{status}")
            return "0-1"

        publisher.publish_status = AsyncMock(side_effect=_flaky_status)

        await mgr._finalize_session(session)

        # The client still gets a terminal status, just on the old late timeline.
        assert order.count("status:closed") == 1, order
        assert order.index("session.close") < order.index("status:closed"), order
