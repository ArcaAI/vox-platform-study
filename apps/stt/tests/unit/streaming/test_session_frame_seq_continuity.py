"""TASK-985 M-66 / M-65 — bill distinct audio, and bound what we hold of it.

`total_duration_seconds` IS the invoice: `_finalize_session_locked` reads it
into the teardown summary and the gateway emits it as the `AUDIO_SECOND`
component of the `transcribe.stream` ledger row.

`record_frame` used to add duration on every DISPATCH with no seq check. The
ingestion consumer XACKs entries after dispatching them, so a worker that dies
in between leaves them in the PEL, and recovery's first-pass
`XAUTOCLAIM(min_idle 0, force=True)` redelivers them — billing the same audio
twice. Billing on delivery count is billing on a transport artifact; the
gateway already assigns a monotonic `seq` once per frame, so distinctness is
decidable at ingest with no new state and no coordination.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest


def _make_session(session_id: str = "sess_seq"):
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


#: 160 samples = 10 ms at 16 kHz.
_FRAME = b"\x01\x02" * 160


class TestSeqContinuityIsBilling:
    def test_a_redelivered_frame_adds_no_duration(self):
        session = _make_session()

        session.record_frame(seq=1, data=_FRAME, sample_rate=16000)
        session.record_frame(seq=2, data=_FRAME, sample_rate=16000)
        billed = session.total_duration_seconds
        buffered = len(session.audio_buffer)

        # The exact XAUTOCLAIM redelivery: both entries arrive again.
        session.record_frame(seq=1, data=_FRAME, sample_rate=16000)
        session.record_frame(seq=2, data=_FRAME, sample_rate=16000)

        assert session.total_duration_seconds == billed
        assert session.total_samples_received == 320
        # ...and the durable buffer is not duplicated either.
        assert len(session.audio_buffer) == buffered
        assert session.frames_redelivered == 2

    def test_a_gap_is_counted_so_coverage_is_derivable(self):
        session = _make_session()

        session.record_frame(seq=1, data=_FRAME, sample_rate=16000)
        session.record_frame(seq=5, data=_FRAME, sample_rate=16000)

        assert session.frames_missing == 3
        # A gap is still BILLED for what arrived, never for what did not.
        assert session.total_samples_received == 320

    def test_the_first_frame_is_not_treated_as_a_gap(self):
        """`last_seq` starts at -1; a session opening at seq 0 or 1 is normal."""
        session = _make_session()

        session.record_frame(seq=0, data=_FRAME, sample_rate=16000)

        assert session.frames_missing == 0
        assert session.total_samples_received == 160

    def test_a_zero_length_terminal_frame_advances_seq_without_billing(self):
        """The M-29 marker must pass the guard and still cost nothing."""
        session = _make_session()

        session.record_frame(seq=1, data=_FRAME, sample_rate=16000)
        session.record_frame(seq=2, data=b"", sample_rate=16000)

        assert session.last_seq == 2
        assert session.total_samples_received == 160
        assert session.frames_redelivered == 0


class TestProcessedBufferCap:
    def test_the_processed_buffer_stops_growing_at_the_cap(self):
        """M-65 — it was the one buffer of the three with no bound at all."""
        session = _make_session()
        session._max_audio_buffer_bytes = 1000

        session.append_processed_audio(b"\x00" * 600)
        assert len(session.processed_audio_buffer) == 600

        session.append_processed_audio(b"\x00" * 600)  # would exceed the cap
        assert len(session.processed_audio_buffer) == 600

        session.append_processed_audio(b"\x00" * 200)  # still fits
        assert len(session.processed_audio_buffer) == 800

    def test_an_empty_append_is_a_no_op(self):
        session = _make_session()
        session.append_processed_audio(b"")
        assert len(session.processed_audio_buffer) == 0


class TestCapacityReconciler:
    @pytest.mark.asyncio
    async def test_a_session_in_creation_is_not_reclaimed(self):
        """N-1 — a cold model load straddles a heartbeat tick.

        A session admitted into the capacity guard but still inside
        `create_session` is absent from `self._sessions` and was therefore
        indistinguishable from a leaked slot. Releasing it exceeds the cap
        silently, and the later `remove_session` release is a no-op.
        """
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
            vad_silence_threshold_ms=700,
            multi_gpu_strategy="none",
        )
        redis_mock = AsyncMock()
        redis_mock.scan = AsyncMock(return_value=(0, []))
        mgr = SessionManager(redis=redis_mock, profile=profile, worker_id="test-worker")

        released: list[str] = []
        mgr._capacity_guard.release = AsyncMock(side_effect=lambda sid: released.append(sid))

        assert await mgr._capacity_guard.try_acquire("cold_session") is True
        mgr._creating.add("cold_session")

        await mgr._reconcile_capacity_guard()
        assert released == []

        # Once creation finishes WITHOUT registering (a genuine leak), it is
        # reclaimed as before.
        mgr._creating.discard("cold_session")
        await mgr._reconcile_capacity_guard()
        assert released == ["cold_session"]
