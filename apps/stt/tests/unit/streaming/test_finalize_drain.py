"""An out-of-band finalize must not drop audio that is already on ``stt:audio``.

``stop`` reaches STT twice: in band (a zero-length ``final=1`` frame appended to
``stt:audio`` after the last audio frame) and out of band (a control
``FINALIZE`` on ``stt:control``). The two streams have no mutual ordering, so the
control listener can read its entry while the ingestion consumer still has
audio queued. Flipping the session to FINALIZING at that moment made
``_on_frame`` drop the tail of the recording — from the captions AND from the
stored raw WAV.

The control ``FINALIZE`` (and the HTTP DELETE, which is also out of band) now
waits, bounded, until the consumer has read up to the stream's tail as it stood
when the finalize arrived — or until the in-band terminal frame has been seen.
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

_PCM = b"\x00\x01" * 160  # 10 ms at 16 kHz
_WAV_HEADER_BYTES = 44


def _make_session(session_id: str = "sess_drain"):
    from stt.streaming.schemas import SessionMetadata, SessionStatus
    from stt.streaming.session import StreamSession

    meta = SessionMetadata(
        session_id=session_id,
        tenant_id="t1",
        pipeline_id="p1",
        consultation_id="c1",
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


def _frame(seq: int, data: bytes = _PCM, final: bool = False):
    from stt.streaming.schemas import AudioEncoding, AudioFrame

    return AudioFrame(
        seq=seq, sr=16000, enc=AudioEncoding.PCM_S16LE, ch=1, data=data, final=final, ts=0.0
    )


def _entry_id(n: int) -> bytes:
    # Production reads the stream with decode_responses=False, so ids are bytes.
    return f"1700000000000-{n}".encode()


class _Wired:
    """A manager + session whose finalize side effects are observable and I/O-free."""

    def __init__(self, tail_entry: int | None) -> None:
        self.mgr = _make_manager()
        self.session = _make_session()
        sid = self.session.session_id
        self.mgr._sessions[sid] = self.session

        publisher = MagicMock()
        publisher.publish_status = AsyncMock()
        publisher.publish = AsyncMock()
        self.mgr._publishers[sid] = publisher
        self.publisher = publisher

        self.uploaded_wavs: list[bytes] = []

        async def _raw_complete(*, wav_bytes: bytes, **_kwargs):
            self.uploaded_wavs.append(wav_bytes)
            return "s3://bucket/complete.wav"

        blob = MagicMock()
        blob.upload_streaming_raw_chunk = AsyncMock(return_value=None)
        blob.upload_streaming_raw_complete = AsyncMock(side_effect=_raw_complete)
        blob.upload_streaming_processed_complete = AsyncMock(return_value=None)
        blob.upload_streaming_transcript = AsyncMock(return_value="s3://bucket/transcript.json")
        blob.upload_streaming_metadata = AsyncMock(return_value="s3://bucket/metadata.json")
        self.mgr._blob_service = blob
        self.blob = blob
        self.mgr._register_dual_capture = AsyncMock()
        self.mgr._persist_streaming_transcript = AsyncMock()

        # The audio consumer: alive, and reading the stream at its own pace.
        consumer = MagicMock()
        consumer.is_running = True
        consumer.stop = AsyncMock()
        self.mgr._consumers[sid] = consumer

        # What XREVRANGE COUNT 1 returns: the newest entry on stt:audio.
        tail = [] if tail_entry is None else [(_entry_id(tail_entry), {b"seq": b"0"})]
        self.mgr._redis.xrevrange = AsyncMock(return_value=tail)

        self.on_frame = self.mgr._make_frame_handler(self.session, preprocessor=None)
        self.on_batch = self.mgr._make_batch_handler(self.session)
        self.on_control = self.mgr._make_control_handler(self.session, preprocessor=None)

    async def finalize_via_control(self) -> None:
        from stt.streaming.schemas import ControlAction, SessionControl

        await self.on_control(SessionControl(action=ControlAction.FINALIZE))


async def _yield(times: int = 10) -> None:
    for _ in range(times):
        await asyncio.sleep(0)


class TestControlFinalizeDrainsTheBacklog:
    @pytest.mark.asyncio
    async def test_frames_already_written_when_the_control_finalize_arrives_are_all_kept(self):
        from stt.streaming.schemas import SessionStatus

        n = 10
        w = _Wired(tail_entry=n)

        control = asyncio.create_task(w.finalize_via_control())
        await _yield()
        # The finalize is holding: nothing may be dropped yet.
        assert w.session.status == SessionStatus.ACTIVE

        for seq in range(1, n + 1):
            await w.on_frame(_frame(seq))
        # A batch that stops short of the tail is not enough (ids compare numerically).
        await w.on_batch(_entry_id(n - 1).decode())
        await _yield()
        assert w.session.status == SessionStatus.ACTIVE
        await w.on_batch(_entry_id(n).decode())

        await asyncio.wait_for(control, timeout=2.0)

        assert w.session.frames_dropped_after_finalize == 0
        assert len(w.session.audio_buffer) == n * len(_PCM)
        assert w.session.status == SessionStatus.CLOSED
        # The STORED recording carries every frame.
        assert len(w.uploaded_wavs) == 1
        assert len(w.uploaded_wavs[0]) - _WAV_HEADER_BYTES == n * len(_PCM)

    @pytest.mark.asyncio
    async def test_the_in_band_final_releases_the_wait_and_the_recording_is_uploaded_once(self):
        n = 6
        w = _Wired(tail_entry=n + 1)

        control = asyncio.create_task(w.finalize_via_control())
        await _yield()

        for seq in range(1, n + 1):
            await w.on_frame(_frame(seq))
        await w.on_frame(_frame(n + 1, data=b"", final=True))

        await asyncio.wait_for(control, timeout=2.0)

        assert w.session.frames_dropped_after_finalize == 0
        assert len(w.session.audio_buffer) == n * len(_PCM)
        assert w.blob.upload_streaming_raw_complete.await_count == 1
        assert len(w.uploaded_wavs[0]) - _WAV_HEADER_BYTES == n * len(_PCM)
        # One terminal status, not two.
        closed = [c for c in w.publisher.publish_status.await_args_list if c.args == ("closed",)]
        assert len(closed) == 1

    @pytest.mark.asyncio
    async def test_frames_after_the_in_band_final_are_still_dropped_and_counted(self):
        w = _Wired(tail_entry=None)

        await w.on_frame(_frame(1))
        await w.on_frame(_frame(2, data=b"", final=True))
        await w.on_frame(_frame(3))

        assert w.session.frames_dropped_after_finalize == 1
        assert len(w.session.audio_buffer) == len(_PCM)

    @pytest.mark.asyncio
    async def test_the_wait_is_bounded_by_the_tail_wait_budget(self):
        from stt.streaming.schemas import SessionStatus

        w = _Wired(tail_entry=5)
        w.mgr._tail_wait_timeout_s = 0.05

        started = time.monotonic()
        await asyncio.wait_for(w.finalize_via_control(), timeout=2.0)
        elapsed = time.monotonic() - started

        # It waited for the consumer, gave up at the bound, and still finalized.
        assert elapsed >= 0.04
        assert w.session.status == SessionStatus.CLOSED

    @pytest.mark.asyncio
    async def test_no_wait_when_the_consumer_already_read_the_tail(self):
        from stt.streaming.schemas import SessionStatus

        w = _Wired(tail_entry=3)
        w.mgr._tail_wait_timeout_s = 5.0
        await w.on_batch(_entry_id(3).decode())

        await asyncio.wait_for(w.finalize_via_control(), timeout=0.5)

        assert w.session.status == SessionStatus.CLOSED

    @pytest.mark.asyncio
    async def test_no_wait_when_no_consumer_is_running(self):
        from stt.streaming.schemas import SessionStatus

        w = _Wired(tail_entry=3)
        w.mgr._tail_wait_timeout_s = 5.0
        w.mgr._consumers[w.session.session_id].is_running = False

        await asyncio.wait_for(w.finalize_via_control(), timeout=0.5)

        assert w.session.status == SessionStatus.CLOSED


class TestHttpTeardownDrainsTheBacklog:
    @pytest.mark.asyncio
    async def test_end_session_keeps_frames_written_before_the_delete(self):
        """The DELETE (a superseded session, an explicit close) is out of band too."""
        n = 8
        w = _Wired(tail_entry=n)

        ending = asyncio.create_task(w.mgr.end_session(w.session.session_id))
        await _yield()

        for seq in range(1, n + 1):
            await w.on_frame(_frame(seq))
        await w.on_batch(_entry_id(n).decode())

        summary = await asyncio.wait_for(ending, timeout=2.0)

        assert summary is not None
        assert w.session.frames_dropped_after_finalize == 0
        assert len(w.uploaded_wavs[0]) - _WAV_HEADER_BYTES == n * len(_PCM)
