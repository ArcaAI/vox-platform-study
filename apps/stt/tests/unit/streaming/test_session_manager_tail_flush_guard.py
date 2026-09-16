"""F-32 — the tail flush/drain must run at most ONCE per session.

`_flush_final_utterance` + `_drain_inference_queue` run OUTSIDE the per-session
finalize lock at every finalize trigger site (``end_session``, the final audio
frame, the control ``FINALIZE`` command, and the idle reaper). Two
near-simultaneous triggers therefore both flushed the preprocessor tail and both
drained the queue — a double-tail: the closing utterance could be transcribed
and published twice.

The fix is a per-session test-and-set flag consumed BEFORE the first ``await``
(the event loop is single-threaded, so the read+write pair is atomic); the
second entrant skips straight to ``_finalize_session``, which stays
lock-serialized and idempotent.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest


def _make_session(
    session_id: str = "sess_tail",
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
        max_concurrent_streams=10,
        batch_scheduler_max_wait_ms=500,
        vad_silence_threshold_ms=700,
        multi_gpu_strategy="none",
    )
    redis_mock = AsyncMock()
    redis_mock.scan = AsyncMock(return_value=(0, []))
    return SessionManager(redis=redis_mock, profile=profile, worker_id="test-worker")


def _instrument(mgr, *, flush_delay_s: float = 0.02):
    """Replace flush/drain/finalize with awaitable counters.

    ``flush_delay_s`` keeps the first entrant suspended inside the tail flush so a
    second trigger genuinely overlaps it (the exact race the guard must close).
    """
    counters = {"flush": 0, "drain": 0, "finalize": 0}

    async def _flush(session, preprocessor):  # noqa: ANN001 - test double
        counters["flush"] += 1
        await asyncio.sleep(flush_delay_s)

    async def _drain(session_id):  # noqa: ANN001 - test double
        counters["drain"] += 1

    async def _finalize(session):  # noqa: ANN001 - test double
        counters["finalize"] += 1

    mgr._flush_final_utterance = _flush
    mgr._drain_inference_queue = _drain
    mgr._finalize_session = _finalize
    return counters


class TestTailFlushGuard:
    @pytest.mark.asyncio
    async def test_two_racing_end_session_triggers_flush_tail_once(self):
        """Two overlapping finalize triggers ⇒ exactly ONE tail flush + drain."""
        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session
        counters = _instrument(mgr)
        mgr.remove_session = AsyncMock()

        await asyncio.gather(
            mgr.end_session(session.session_id),
            mgr.end_session(session.session_id),
        )

        assert counters["flush"] == 1
        assert counters["drain"] == 1
        # Both entrants still reach the (lock-serialized, idempotent) finalize.
        assert counters["finalize"] == 2

    @pytest.mark.asyncio
    async def test_single_trigger_still_flushes_the_tail(self):
        """Regression lock: the normal single-trigger path is unchanged."""
        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session
        counters = _instrument(mgr, flush_delay_s=0)
        mgr.remove_session = AsyncMock()

        await mgr.end_session(session.session_id)

        assert counters == {"flush": 1, "drain": 1, "finalize": 1}

    @pytest.mark.asyncio
    async def test_control_finalize_after_final_frame_skips_second_tail_flush(self):
        """The guard spans DIFFERENT trigger sites, not just repeats of one.

        Simulates the real double-tail: the final audio frame flushes the tail,
        then the client's control ``FINALIZE`` arrives right behind it.
        """
        from stt.streaming.schemas import ControlAction, SessionControl, SessionStatus

        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session
        counters = _instrument(mgr, flush_delay_s=0)
        mgr.remove_session = AsyncMock()
        publisher = MagicMock()
        publisher.publish_status = AsyncMock()
        mgr._publishers[session.session_id] = publisher

        # Site A — final audio frame path.
        await mgr.end_session(session.session_id)
        assert counters["flush"] == 1

        # Site B — control FINALIZE lands just after; session is not CLOSED
        # (the finalize double is a no-op stub), so it reaches the flush block.
        assert session.status is not SessionStatus.CLOSED
        handler = mgr._make_control_handler(session, preprocessor=None)
        await handler(SessionControl(action=ControlAction.FINALIZE))

        assert counters["flush"] == 1
        assert counters["drain"] == 1

    @pytest.mark.asyncio
    async def test_removing_the_session_clears_the_guard(self):
        """The per-session flag is dropped with the session (no id leak)."""
        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session
        counters = _instrument(mgr, flush_delay_s=0)

        await mgr.end_session(session.session_id)
        assert session.session_id in mgr._tail_flush_started

        await mgr.remove_session(session.session_id)
        assert session.session_id not in mgr._tail_flush_started

        # A brand-new session reusing the id flushes its own tail.
        session2 = _make_session()
        mgr._sessions[session2.session_id] = session2
        await mgr.end_session(session2.session_id)
        assert counters["flush"] == 2
