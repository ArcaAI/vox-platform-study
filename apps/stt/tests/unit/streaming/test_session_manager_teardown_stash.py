"""TASK-985 M-23 — every finalize path must produce exactly one ledger row.

Four finalizers converge on one session, and three of them USED to build the
usage-attribution teardown summary and throw it away:

===============================  ==========================  ================
finalizer                        returns the summary to      ledger row?
===============================  ==========================  ================
``end_session`` (HTTP DELETE)    the gateway                  yes
final audio frame                nobody                       no
control ``FINALIZE``             nobody                       no
idle reaper                      ``_push_streaming_usage_back``  yes
===============================  ==========================  ================

So the ORDINARY clean stop — control ``FINALIZE`` first, DELETE second —
produced no ``transcribe.stream`` row at all: the DELETE found no session and
answered 204, and the gateway only emits ``if (summary)``.

This is billing correctness, so the tests below assert the quantity is emitted
EXACTLY once and that the gateway (not STT) keeps the ``interrupted`` verdict.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest


def _make_session(session_id: str = "sess_stash"):
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


class TestTeardownSummaryStash:
    @pytest.mark.asyncio
    async def test_control_finalize_stashes_and_a_later_delete_claims_it(self):
        """The exact clean-stop sequence that used to emit no row at all."""
        from stt.streaming.schemas import ControlAction, SessionControl

        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session
        publisher = MagicMock()
        publisher.publish_status = AsyncMock()
        mgr._publishers[session.session_id] = publisher

        handler = mgr._make_control_handler(session, preprocessor=None)
        await handler(SessionControl(action=ControlAction.FINALIZE))

        # The session is gone — which is exactly when the DELETE arrives.
        assert mgr.get_session(session.session_id) is None
        claimed = mgr.claim_teardown_summary(session.session_id)
        assert claimed is not None
        assert claimed["session_id"] == session.session_id

    @pytest.mark.asyncio
    async def test_the_stash_is_claimed_at_most_once(self):
        """Two DELETEs must not both hand the gateway a row to emit."""
        mgr = _make_manager()
        mgr._stash_teardown_summary("sess_x", {"session_id": "sess_x"})

        assert mgr.claim_teardown_summary("sess_x") is not None
        assert mgr.claim_teardown_summary("sess_x") is None

    @pytest.mark.asyncio
    async def test_the_http_finalizer_does_not_stash(self):
        """``end_session`` RETURNS the summary, so stashing it would duplicate."""
        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session

        summary = await mgr.end_session(session.session_id)

        assert summary is not None
        assert session.session_id not in mgr._pending_teardown_summaries

    @pytest.mark.asyncio
    async def test_an_expired_stash_is_pushed_back_rather_than_dropped(self):
        """A summary nobody came for is still a consultation that was served."""
        mgr = _make_manager()
        pushed: list[tuple[dict, bool]] = []

        async def _push(summary, *, interrupted=True):  # noqa: ANN001 - test double
            pushed.append((summary, interrupted))

        mgr._push_streaming_usage_back = _push
        mgr._teardown_stash_ttl_s = 0.0
        mgr._stash_teardown_summary("sess_y", {"session_id": "sess_y"})

        await asyncio.sleep(0.01)
        await mgr._sweep_teardown_summaries()

        assert pushed == [({"session_id": "sess_y"}, True)]
        assert "sess_y" not in mgr._pending_teardown_summaries

    @pytest.mark.asyncio
    async def test_a_summary_its_finalizer_already_pushed_is_not_pushed_twice(self):
        """The reaper emits immediately; the sweep must not re-emit."""
        mgr = _make_manager()
        pushed: list[dict] = []

        async def _push(summary, *, interrupted=True):  # noqa: ANN001 - test double
            pushed.append(summary)

        mgr._push_streaming_usage_back = _push
        mgr._teardown_stash_ttl_s = 0.0
        mgr._stash_teardown_summary("sess_z", {"session_id": "sess_z"}, pushed_back=True)

        await asyncio.sleep(0.01)
        await mgr._sweep_teardown_summaries()

        assert pushed == []
        # A late DELETE is answered honestly rather than re-emitting.
        assert mgr.claim_teardown_summary("sess_z") is None

    @pytest.mark.asyncio
    async def test_the_stash_is_bounded_by_entry_count(self):
        """An in-memory map on a PHI service does not grow without a ceiling."""
        from stt.streaming.session_manager import _TEARDOWN_STASH_MAX_ENTRIES

        mgr = _make_manager()

        async def _push(summary, *, interrupted=True):  # noqa: ANN001 - test double
            return None

        mgr._push_streaming_usage_back = _push
        for index in range(_TEARDOWN_STASH_MAX_ENTRIES + 10):
            mgr._stash_teardown_summary(f"sess_{index}", {"session_id": f"sess_{index}"})

        assert len(mgr._pending_teardown_summaries) == _TEARDOWN_STASH_MAX_ENTRIES
        # Oldest-first eviction: the first ids are the ones that went.
        assert "sess_0" not in mgr._pending_teardown_summaries
        assert f"sess_{_TEARDOWN_STASH_MAX_ENTRIES + 9}" in mgr._pending_teardown_summaries
