"""F-32 — the tail flush/drain must run at most ONCE per session.

`_flush_final_utterance` + `_drain_inference_queue` run OUTSIDE the per-session
finalize lock at every finalize trigger site (``end_session``, the final audio
frame, the control ``FINALIZE`` command, and the idle reaper). Two
near-simultaneous triggers therefore both flushed the preprocessor tail and both
drained the queue — a double-tail: the closing utterance could be transcribed
and published twice.

The fix is a per-session test-and-set flag consumed BEFORE the first ``await``
(the event loop is single-threaded, so the read+write pair is atomic).

TASK-985 M-04 — that flag was mutual exclusion WITHOUT a happens-before edge,
and the second entrant read "someone else started the tail" as "the tail is
done": it went straight to ``_finalize_session``, published the terminal
``closed`` status, built ``transcript.json`` and called ``remove_session``,
which cancelled the first entrant's still-running tail decode. The flag is now
an ``asyncio.Event`` per session, SET in a ``finally`` by the owner and AWAITED
(bounded, non-fatal) by every later trigger. ``TestTailCompletionLatch`` below
pins that ordering; ``TestTailFlushGuard`` keeps pinning F-32's exclusion.
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
        assert session.session_id in mgr._tail_flush_done

        await mgr.remove_session(session.session_id)
        assert session.session_id not in mgr._tail_flush_done

        # A brand-new session reusing the id flushes its own tail.
        session2 = _make_session()
        mgr._sessions[session2.session_id] = session2
        await mgr.end_session(session2.session_id)
        assert counters["flush"] == 2


class TestTailCompletionLatch:
    """TASK-985 M-04 — the latch supplies a HAPPENS-BEFORE edge, not just exclusion.

    The invariant under test, stated once:

        For a given session, ``publish_status("closed")`` and
        ``build_transcript_json()`` are reachable only after that session's tail
        flush + inference drain has COMPLETED, or after its bounded wait has
        timed out.
    """

    @pytest.mark.asyncio
    async def test_later_trigger_finalizes_only_after_the_tail_completes(self):
        """The ordering the lost tail utterance was the symptom of."""
        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session
        mgr.remove_session = AsyncMock()

        events: list[str] = []

        async def _flush(session, preprocessor):  # noqa: ANN001 - test double
            events.append("tail_start")
            # Long enough that the second trigger is genuinely inside its wait.
            await asyncio.sleep(0.05)
            events.append("tail_end")

        async def _drain(session_id):  # noqa: ANN001 - test double
            events.append("drain_end")

        async def _finalize(session):  # noqa: ANN001 - test double
            events.append("finalize")

        mgr._flush_final_utterance = _flush
        mgr._drain_inference_queue = _drain
        mgr._finalize_session = _finalize

        await asyncio.gather(
            mgr.end_session(session.session_id),
            mgr.end_session(session.session_id),
        )

        assert events.count("tail_start") == 1
        assert events.count("finalize") == 2
        tail_end = events.index("drain_end")
        # EVERY finalize — the owner's and the waiter's — is after the tail.
        assert all(i > tail_end for i, e in enumerate(events) if e == "finalize")

    @pytest.mark.asyncio
    async def test_closed_status_is_published_after_the_tail(self):
        """The same invariant through the REAL finalize path, at the publisher.

        ``closed`` is terminal: the gateway's caption subscription completes on
        it and drops everything published afterwards, so publishing it while a
        tail decode is still running is what loses the closing utterance.
        """
        from stt.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session

        events: list[str] = []

        publisher = MagicMock()

        async def _publish_status(status):  # noqa: ANN001 - test double
            events.append(f"status:{status}")

        publisher.publish_status = _publish_status
        mgr._publishers[session.session_id] = publisher

        async def _flush(session, preprocessor):  # noqa: ANN001 - test double
            await asyncio.sleep(0.05)
            events.append("tail_end")

        async def _drain(session_id):  # noqa: ANN001 - test double
            return None

        mgr._flush_final_utterance = _flush
        mgr._drain_inference_queue = _drain

        # No audio buffered ⇒ the upload/persist block is skipped entirely and
        # the real ordering (`closed` before the durability work) is unchanged.
        assert not session.audio_buffer and not session.processed_audio_buffer

        await asyncio.gather(
            mgr.end_session(session.session_id),
            mgr.end_session(session.session_id),
        )

        assert session.status is SessionStatus.CLOSED
        assert "tail_end" in events
        assert "status:closed" in events
        assert events.index("tail_end") < events.index("status:closed")

    @pytest.mark.asyncio
    async def test_a_raising_drain_still_releases_the_waiters(self):
        """``finally: set()`` is the deadlock guard, not tidiness.

        ``_flush_final_utterance`` swallows its own exceptions;
        ``_drain_inference_queue`` does not — and the reaper must always be able
        to finish.
        """
        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session
        mgr.remove_session = AsyncMock()

        finalized: list[str] = []

        async def _flush(session, preprocessor):  # noqa: ANN001 - test double
            await asyncio.sleep(0.01)

        async def _drain(session_id):  # noqa: ANN001 - test double
            raise RuntimeError("drain exploded")

        async def _finalize(session):  # noqa: ANN001 - test double
            finalized.append(session.session_id)

        mgr._flush_final_utterance = _flush
        mgr._drain_inference_queue = _drain
        mgr._finalize_session = _finalize

        _owner, waiter = await asyncio.gather(
            mgr.end_session(session.session_id),
            mgr.end_session(session.session_id),
            return_exceptions=True,
        )

        # The owner's failure is handled by `end_session`'s own except (forced
        # removal); the WAITER must not be wedged behind the dead owner.
        assert mgr._tail_flush_done[session.session_id].is_set()
        assert finalized == [session.session_id]
        assert not isinstance(waiter, BaseException)

    @pytest.mark.asyncio
    async def test_the_wait_is_bounded_and_teardown_still_completes(self):
        """A wedged tail must cost one utterance, never a leaked GPU slot."""
        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session
        mgr.remove_session = AsyncMock()
        mgr._tail_wait_timeout_s = 0.02

        finalized: list[str] = []
        release = asyncio.Event()

        async def _flush(session, preprocessor):  # noqa: ANN001 - test double
            await release.wait()

        async def _drain(session_id):  # noqa: ANN001 - test double
            return None

        async def _finalize(session):  # noqa: ANN001 - test double
            finalized.append(session.session_id)

        mgr._flush_final_utterance = _flush
        mgr._drain_inference_queue = _drain
        mgr._finalize_session = _finalize

        owner_task = asyncio.create_task(mgr.end_session(session.session_id))
        await asyncio.sleep(0)  # let the owner claim the latch and start flushing

        # The waiter gives up after the bound and finalizes anyway.
        await asyncio.wait_for(mgr.end_session(session.session_id), timeout=1.0)
        assert finalized == [session.session_id]

        release.set()
        await owner_task
        assert finalized == [session.session_id, session.session_id]

    @pytest.mark.asyncio
    async def test_finalize_locked_waits_at_the_sink_too(self):
        """Defense in depth: the contract is enforced where it is STATED.

        A fifth finalize trigger added later must inherit the invariant without
        having to remember the protocol, so ``_finalize_session_locked`` repeats
        the bounded wait even though all four current callers already did it.
        """
        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session
        mgr.remove_session = AsyncMock()

        # Claim the latch WITHOUT completing it, exactly as an in-flight tail
        # flush would, then finalize directly (bypassing `_run_tail_flush`).
        owned, tail_done = mgr._begin_tail_flush(session.session_id)
        assert owned is True

        waited: list[str] = []
        real_await = mgr._await_tail_flush

        async def _spy(session_id, event):  # noqa: ANN001 - test double
            waited.append(session_id)
            return await real_await(session_id, event)

        mgr._await_tail_flush = _spy
        mgr._tail_wait_timeout_s = 0.02

        await mgr._finalize_session(session)

        assert waited == [session.session_id]
        tail_done.set()

    @pytest.mark.asyncio
    async def test_no_latch_entry_means_nothing_to_wait_for(self):
        """An absent entry is "nobody claimed a tail", not "wait for one"."""
        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session
        mgr.remove_session = AsyncMock()
        mgr._tail_wait_timeout_s = 30.0  # would hang if the absent case waited

        waited: list[str] = []

        async def _spy(session_id, event):  # noqa: ANN001 - test double
            waited.append(session_id)
            return True

        mgr._await_tail_flush = _spy

        assert session.session_id not in mgr._tail_flush_done
        await asyncio.wait_for(mgr._finalize_session(session), timeout=1.0)
        assert waited == []
