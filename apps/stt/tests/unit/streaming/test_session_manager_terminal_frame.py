"""TASK-985 M-29 — the in-band terminal frame, from the STT side.

`stop` reaches STT today as a control command on `stt:control` while audio
flows on `stt:audio`. Two Redis streams have NO mutual ordering, so the control
listener can flip the session to FINALIZING while the ingestion consumer still
has unread audio entries — and `_on_frame`'s first line then discards every one
of them.

The fix is to send `stop` IN BAND: a zero-length `final=1` frame appended to
`stt:audio`, which is ordered against the audio by construction. The wire
already supports it (`writeAudioFrame(..., isFinal)`) and `_on_frame` already
has the `if frame.final:` branch. Writing it is the gateway's half; this file
pins the STT-side properties that half depends on.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest


def _make_session(session_id: str = "sess_terminal"):
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


def _frame(seq: int, data: bytes = b"", final: bool = False):
    from stt.streaming.schemas import AudioEncoding, AudioFrame

    return AudioFrame(
        seq=seq,
        sr=16000,
        enc=AudioEncoding.PCM_S16LE,
        ch=1,
        data=data,
        final=final,
        ts=0.0,
    )


class TestTerminalFrame:
    @pytest.mark.asyncio
    async def test_a_zero_length_terminal_frame_bills_nothing(self):
        """The marker must not inflate the billed quantity.

        `total_duration_seconds` IS the invoice — it becomes the AUDIO_SECOND
        component of the `transcribe.stream` ledger row — so a control signal
        travelling as a frame has to be free.
        """
        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session
        mgr._finalize_session = AsyncMock(return_value=None)

        handler = mgr._make_frame_handler(session, preprocessor=None)
        await handler(_frame(seq=1, data=b"\x00\x01" * 160))
        billed_before = session.total_duration_seconds
        samples_before = session.total_samples_received

        await handler(_frame(seq=2, data=b"", final=True))

        assert session.total_duration_seconds == billed_before
        assert session.total_samples_received == samples_before

    @pytest.mark.asyncio
    async def test_a_zero_length_terminal_frame_still_finalizes(self):
        """An empty body is a marker, not a no-op: it must trigger the tail."""
        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session

        flushed: list[str] = []

        async def _flush(session, preprocessor):  # noqa: ANN001 - test double
            flushed.append(session.session_id)

        async def _drain(session_id):  # noqa: ANN001 - test double
            return None

        mgr._flush_final_utterance = _flush
        mgr._drain_inference_queue = _drain
        mgr._finalize_session = AsyncMock(return_value=None)

        # No preprocessor: the final-frame branch is what is under test, and
        # `_flush_final_utterance` is stubbed above anyway.
        handler = mgr._make_frame_handler(session, preprocessor=None)
        await handler(_frame(seq=1, data=b"", final=True))

        assert flushed == [session.session_id]
        mgr._finalize_session.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_frames_arriving_after_finalize_are_counted_not_silently_dropped(self):
        """The M-29 residual has to be measurable, or it stays invisible."""
        from stt.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session

        handler = mgr._make_frame_handler(session, preprocessor=None)
        session.status = SessionStatus.FINALIZING

        await handler(_frame(seq=5, data=b"\x00\x01" * 160))
        await handler(_frame(seq=6, data=b"\x00\x01" * 160))

        assert session.frames_dropped_after_finalize == 2
        # ...and none of that audio was billed or buffered.
        assert session.total_duration_seconds == 0.0
        assert len(session.audio_buffer) == 0
