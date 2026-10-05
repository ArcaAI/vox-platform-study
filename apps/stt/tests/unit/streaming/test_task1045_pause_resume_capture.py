"""TASK-1045 AB-STT — backend PAUSE / RESUME of a live streaming session.

Until now ``ControlAction.PAUSE`` / ``RESUME`` were rejected with a client-visible
error. They now mean:

* PAUSE — read the audio already on ``stt:audio``, stop accepting frames, flush
  the open utterance and wait for its final (WITHOUT claiming the once-per-session
  tail latch, which belongs to finalize), push pending finals to the gateway, then
  publish ``status: paused`` carrying ``audioOffsetMs``. The last final is on the
  result stream BEFORE ``paused``.
* While paused every audio frame is dropped and the AUDIO CLOCK does not move
  (no samples, no duration, no preprocessor feed), so the next utterance's
  session-relative times continue exactly where capture stopped.
* RESUME — accept frames again and publish ``status: capturing``.
* The idle reaper skips a paused session until ``streaming_pause_max_s``, then
  publishes ``pause_expired`` and finalizes it.
* The consultation recording (dual capture) is registered as Ogg/Opus.
"""

from __future__ import annotations

import asyncio
import io
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest

from stt.streaming.preprocessor import AudioUtterance
from stt.streaming.schemas import (
    AudioEncoding,
    AudioFrame,
    ControlAction,
    SegmentResult,
    SessionControl,
    SessionMetadata,
    SessionStatus,
)
from stt.streaming.session import StreamSession

SID = "sess_pause"


def _make_session(consultation_id: str | None = "c1") -> StreamSession:
    meta = SessionMetadata(
        session_id=SID,
        tenant_id="t1",
        pipeline_id="p1",
        consultation_id=consultation_id,
        status=SessionStatus.ACTIVE,
        sample_rate=16000,
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
        max_concurrent_streams=10,
        batch_scheduler_max_wait_ms=500,
        multi_gpu_strategy="none",
    )
    redis_mock = AsyncMock()
    redis_mock.scan = AsyncMock(return_value=(0, []))
    return SessionManager(redis=redis_mock, profile=profile, worker_id="test-worker")


def _frame(seq: int, n_samples: int = 1600, final: bool = False) -> AudioFrame:
    return AudioFrame(
        seq=seq,
        sr=16000,
        enc=AudioEncoding.PCM_S16LE,
        ch=1,
        data=b"\x01\x00" * n_samples,
        final=final,
        ts=0.0,
    )


def _tail_utterance(index: int = 4) -> AudioUtterance:
    return AudioUtterance(
        samples=np.zeros(1600, dtype=np.float32),
        sample_rate=16000,
        start_time=3.0,
        end_time=4.0,
        utterance_index=index,
        is_final=True,
    )


def _wire(mgr, session, events: list):
    """Register the session with a recording publisher, worker and outbox."""
    mgr._sessions[SID] = session

    publisher = MagicMock()

    async def _status(status, **kw):
        events.append(("status", status, kw))

    publisher.publish_status = AsyncMock(side_effect=_status)
    publisher.publish_error = AsyncMock(side_effect=lambda msg: events.append(("error", msg)))
    mgr._publishers[SID] = publisher

    worker = MagicMock()

    async def _process(_sid, utt):
        await asyncio.sleep(0.01)  # a decode that takes time
        events.append(("final", utt.utterance_index))
        return SegmentResult(
            text="last words",
            is_final=True,
            utterance_index=utt.utterance_index,
            start_time=utt.start_time,
            end_time=utt.end_time,
        )

    worker.process_utterance = AsyncMock(side_effect=_process)
    mgr._inference_workers[SID] = worker

    outbox = MagicMock()
    outbox.flush = AsyncMock(side_effect=lambda: events.append(("outbox_flush",)))
    outbox.close = AsyncMock()
    mgr._segment_outboxes[SID] = outbox

    preprocessor = MagicMock()
    preprocessor.flush = AsyncMock(return_value=_tail_utterance())
    preprocessor.drain_processed_samples = MagicMock(return_value=b"")
    preprocessor.feed = AsyncMock(return_value=[])
    preprocessor.target_sample_rate = 16000
    mgr._preprocessors[SID] = preprocessor
    return publisher, worker, outbox, preprocessor


class TestPause:
    async def test_last_final_and_outbox_flush_precede_the_paused_status(self):
        mgr = _make_manager()
        session = _make_session()
        events: list = []
        _, worker, _, preprocessor = _wire(mgr, session, events)
        queue: asyncio.Queue = asyncio.Queue()
        mgr._inference_queues[SID] = queue
        loop_task = mgr._start_inference_loop(session, worker, queue)
        mgr._inference_tasks[SID] = loop_task
        session.record_frame(0, b"\x00\x00" * 16000, 16000)  # 1 s of audio

        handler = mgr._make_control_handler(session, preprocessor)
        await handler(SessionControl(action=ControlAction.PAUSE))

        assert events == [
            ("final", 4),
            ("outbox_flush",),
            ("status", "paused", {"audio_offset_ms": 1000}),
        ]
        assert session.capture_paused is True
        assert session.status == SessionStatus.ACTIVE
        # The inference loop survives a pause — resume keeps decoding.
        assert not loop_task.done()
        loop_task.cancel()

    async def test_pause_does_not_claim_the_finalize_tail_latch(self):
        mgr = _make_manager()
        session = _make_session()
        events: list = []
        _, _, _, preprocessor = _wire(mgr, session, events)

        await mgr._make_control_handler(session, preprocessor)(
            SessionControl(action=ControlAction.PAUSE)
        )

        assert SID not in mgr._tail_flush_done
        assert ("final", 4) in events  # the inline path decoded the tail
        assert not [e for e in events if e[0] == "error"]

    async def test_pause_twice_is_idempotent(self):
        mgr = _make_manager()
        session = _make_session()
        events: list = []
        _, _, _, preprocessor = _wire(mgr, session, events)
        handler = mgr._make_control_handler(session, preprocessor)

        await handler(SessionControl(action=ControlAction.PAUSE))
        await handler(SessionControl(action=ControlAction.PAUSE))

        assert preprocessor.flush.await_count == 1
        assert [e[1] for e in events if e[0] == "status"] == ["paused", "paused"]


class TestFramesWhilePaused:
    async def test_frames_are_dropped_and_the_audio_clock_does_not_move(self):
        mgr = _make_manager()
        session = _make_session()
        events: list = []
        _, _, _, preprocessor = _wire(mgr, session, events)
        on_frame = mgr._make_frame_handler(session, preprocessor)

        await on_frame(_frame(1))
        assert session.total_duration_seconds == pytest.approx(0.1)
        assert preprocessor.feed.await_count == 1

        await mgr._make_control_handler(session, preprocessor)(
            SessionControl(action=ControlAction.PAUSE)
        )
        await on_frame(_frame(2))
        await on_frame(_frame(3))

        assert session.total_duration_seconds == pytest.approx(0.1)
        assert session.total_samples_received == 1600
        assert len(session.audio_buffer) == 3200
        assert preprocessor.feed.await_count == 1
        assert session.frames_dropped_while_paused == 2

        await mgr._make_control_handler(session, preprocessor)(
            SessionControl(action=ControlAction.RESUME)
        )
        await on_frame(_frame(4))
        assert session.total_duration_seconds == pytest.approx(0.2)
        assert preprocessor.feed.await_count == 2
        # The dropped seqs are not counted as audio the platform never saw.
        assert session.frames_missing == 0

    async def test_terminal_frame_while_paused_still_finalizes(self):
        mgr = _make_manager()
        session = _make_session()
        events: list = []
        _, _, _, preprocessor = _wire(mgr, session, events)
        session.capture_paused = True
        mgr._run_tail_flush = AsyncMock()
        mgr._finalize_session = AsyncMock()

        await mgr._make_frame_handler(session, preprocessor)(_frame(9, n_samples=0, final=True))

        mgr._run_tail_flush.assert_awaited_once()
        mgr._finalize_session.assert_awaited_once()


class TestResume:
    async def test_resume_publishes_capturing_and_refreshes_activity(self):
        mgr = _make_manager()
        session = _make_session()
        events: list = []
        _, _, _, preprocessor = _wire(mgr, session, events)
        handler = mgr._make_control_handler(session, preprocessor)
        session.record_frame(0, b"\x00\x00" * 8000, 16000)
        await handler(SessionControl(action=ControlAction.PAUSE))
        session.metadata.last_activity = (datetime.utcnow() - timedelta(hours=1)).isoformat()

        await handler(SessionControl(action=ControlAction.RESUME))

        assert session.capture_paused is False
        assert session.capture_paused_at is None
        assert events[-1] == ("status", "capturing", {"audio_offset_ms": 500})
        idle = datetime.utcnow() - datetime.fromisoformat(session.last_activity)
        assert idle.total_seconds() < 5


class TestReaper:
    def _idle_paused(self, mgr, paused_for_s: float):
        session = _make_session()
        events: list = []
        _wire(mgr, session, events)
        session.metadata.last_activity = (datetime.utcnow() - timedelta(hours=2)).isoformat()
        session.capture_paused = True
        session.capture_paused_at = datetime.utcnow() - timedelta(seconds=paused_for_s)
        mgr._run_tail_flush = AsyncMock()

        async def _finalize(s, **kw):
            events.append(("finalize", kw))

        mgr._finalize_session = AsyncMock(side_effect=_finalize)
        mgr._pause_max_s = 600
        return session, events

    async def test_paused_session_is_not_reaped_inside_the_pause_limit(self):
        mgr = _make_manager()
        _, events = self._idle_paused(mgr, paused_for_s=120)

        reaped = await mgr._reap_expired_sessions(300)

        assert reaped == 0
        mgr._finalize_session.assert_not_awaited()

    async def test_pause_over_the_limit_publishes_pause_expired_then_finalizes(self):
        mgr = _make_manager()
        _, events = self._idle_paused(mgr, paused_for_s=700)

        reaped = await mgr._reap_expired_sessions(300)

        assert reaped == 1
        statuses = [e for e in events if e[0] in ("status", "finalize")]
        assert statuses[0][:2] == ("status", "pause_expired")
        assert statuses[1][0] == "finalize"

    def test_pause_limit_is_a_control_plane_setting_defaulting_to_600(self):
        from stt.core.config.settings import Settings
        from stt.core.control_plane import CONTROL_PLANE_KEYS

        assert Settings.model_fields["streaming_pause_max_s"].default == 600
        assert CONTROL_PLANE_KEYS["streaming_pause_max_s"] == "stt.streaming.pauseMaxSeconds"
        assert _make_manager()._pause_max_s == 600


class TestOpusRecording:
    def test_encode_ogg_opus_round_trips_the_session_audio(self):
        import soundfile as sf

        session = _make_session()
        session.record_frame(0, (np.ones(16000, dtype=np.int16) * 1000).tobytes(), 16000)

        ogg = session.encode_ogg_opus()

        assert ogg[:4] == b"OggS"
        decoded, sr = sf.read(io.BytesIO(ogg))
        assert sr == 16000
        assert len(decoded) / sr == pytest.approx(1.0, abs=0.05)

    async def test_dual_capture_registers_the_consultation_recording_as_opus(self):
        from stt.pipeline.dto import DualCaptureConfig

        mgr = _make_manager()
        session = _make_session()
        session.record_frame(0, b"\x10\x00" * 16000, 16000)
        mgr._dual_capture[SID] = DualCaptureConfig(enabled=True, capture_raw=True)
        blob = MagicMock()
        blob.upload_audio = AsyncMock(return_value="s3://audio/t1/c1/sess_pause-raw.ogg")
        mgr._blob_service = blob
        gateway = MagicMock()
        gateway.create_media = AsyncMock(return_value={"id": "m1"})
        gateway.create_audio_recording = AsyncMock(return_value={})
        mgr._get_api_client = lambda: gateway

        await mgr._register_dual_capture(session, "s3://audio/raw/complete.wav", None)

        upload_kw = blob.upload_audio.await_args.kwargs
        assert upload_kw["content_type"] == "audio/ogg"
        assert upload_kw["consultation_id"] == "c1"
        assert upload_kw["audio_bytes"][:4] == b"OggS"
        media_kw = gateway.create_media.await_args.kwargs
        assert media_kw["extension"] == "ogg"
        assert media_kw["mime_type"] == "audio/ogg"
        assert media_kw["uri"] == "s3://audio/t1/c1/sess_pause-raw.ogg"
        assert gateway.create_audio_recording.await_args.kwargs["media_id"] == "m1"
