"""TASK-1013 — every streaming session records ONE terminal status.

``stt_streaming_sessions_total`` is incremented with ``status="started"`` when a
session enters ``SessionManager._sessions`` (create, not recovery). Before this
ticket nothing ever recorded how a session ENDED — ``streaming_session_finished()``
had no caller — so the "streaming session success" SLI (deployment repo,
``docs/observability-slos.md`` §3.1) matched no series.

The vocabulary is the closed set ``stt.core.metrics.SESSION_FINISHED_STATUSES``:

- ``closed``    — finalized normally (final frame, control FINALIZE, the gateway's
                  DELETE — which is also how a client disconnect and a gateway
                  resume-grace expiry reach STT), or a client CANCEL;
- ``recovered`` — a session rebuilt after a crash restart, finalized normally;
- ``reaped``    — finalized by the idle reaper;
- ``failed``    — removed WITHOUT a completed finalize (a finalize trigger that
                  raised, a create-time rollback, a failed recovery, a forced removal).

These tests drive the real ``SessionManager`` methods and read the default
Prometheus registry as before/after deltas, so they are order-independent.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from prometheus_client import REGISTRY

from stt.core.metrics import SESSION_FINISHED_STATUSES
from stt.streaming.schemas import SessionMetadata, SessionStatus
from tests.helpers.resolved_spec import resolved_spec

_METRIC = "stt_streaming_sessions_total"


def _counts() -> dict[str, float]:
    return {
        status: REGISTRY.get_sample_value(_METRIC, {"status": status}) or 0.0
        for status in (*SESSION_FINISHED_STATUSES, "started")
    }


def _delta(before: dict[str, float]) -> dict[str, float]:
    after = _counts()
    return {k: after[k] - before[k] for k in after if after[k] != before[k]}


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
    mgr = SessionManager(redis=redis_mock, profile=profile, worker_id="test-worker")
    # Finalize side effects that reach MinIO / the durable transcript store.
    mgr._register_dual_capture = AsyncMock()
    mgr._persist_streaming_transcript = AsyncMock()
    mgr._push_streaming_usage_back = AsyncMock()
    return mgr


def _live_session(mgr, session_id: str = "sess-1013"):
    """A session registered the way ``create_session`` leaves it (no audio)."""
    from stt.streaming.session import StreamSession

    meta = SessionMetadata(
        session_id=session_id,
        tenant_id="t1",
        pipeline_id="p1",
        status=SessionStatus.ACTIVE,
        sample_rate=16000,
    )
    session = StreamSession(metadata=meta, redis=AsyncMock(), persist_interval_s=5.0)
    mgr._sessions[session_id] = session
    mgr._publishers[session_id] = MagicMock(publish_status=AsyncMock(return_value="0-1"))
    return session


class TestNormalClose:
    @pytest.mark.asyncio
    async def test_finalize_records_closed_once(self):
        mgr = _make_manager()
        session = _live_session(mgr)
        before = _counts()

        await mgr._finalize_session(session)

        assert _delta(before) == {"closed": 1}

    @pytest.mark.asyncio
    async def test_a_second_finalizer_and_a_late_removal_record_nothing_more(self):
        mgr = _make_manager()
        session = _live_session(mgr)
        before = _counts()

        await mgr._finalize_session(session)
        await mgr._finalize_session(session)
        await mgr.remove_session(session.session_id)

        assert _delta(before) == {"closed": 1}

    @pytest.mark.asyncio
    async def test_end_session_records_closed(self):
        """The gateway DELETE — the path a client disconnect and a resume-grace
        expiry both take into STT."""
        mgr = _make_manager()
        session = _live_session(mgr)
        mgr._await_audio_backlog = AsyncMock()
        mgr._run_tail_flush = AsyncMock()
        before = _counts()

        await mgr.end_session(session.session_id)

        assert _delta(before) == {"closed": 1}

    @pytest.mark.asyncio
    async def test_client_cancel_records_closed(self):
        mgr = _make_manager()
        session = _live_session(mgr)
        before = _counts()

        await mgr._cancel_session(session)

        assert _delta(before) == {"closed": 1}


class TestFailure:
    @pytest.mark.asyncio
    async def test_end_session_that_raises_records_failed(self):
        mgr = _make_manager()
        session = _live_session(mgr)
        mgr._await_audio_backlog = AsyncMock()
        mgr._run_tail_flush = AsyncMock(side_effect=RuntimeError("tail flush blew up"))
        before = _counts()

        await mgr.end_session(session.session_id)

        assert _delta(before) == {"failed": 1}

    @pytest.mark.asyncio
    async def test_forced_removal_without_finalize_records_failed(self):
        """Create-time rollback / finalize-trigger error paths call this directly."""
        mgr = _make_manager()
        session = _live_session(mgr)
        before = _counts()

        await mgr.remove_session(session.session_id)

        assert _delta(before) == {"failed": 1}

    @pytest.mark.asyncio
    async def test_removing_an_unknown_session_records_nothing(self):
        """No session was counted as started, so no terminal status either."""
        mgr = _make_manager()
        before = _counts()

        await mgr.remove_session("never-registered")

        assert _delta(before) == {}


class TestReaper:
    @staticmethod
    def _go_idle(session) -> None:
        session._metadata.last_activity = (datetime.utcnow() - timedelta(hours=1)).isoformat()

    @pytest.mark.asyncio
    async def test_reaped_session_records_reaped(self):
        mgr = _make_manager()
        session = _live_session(mgr)
        self._go_idle(session)
        mgr._run_tail_flush = AsyncMock()
        before = _counts()

        assert await mgr._reap_expired_sessions(timeout_s=60) == 1

        assert _delta(before) == {"reaped": 1}

    @pytest.mark.asyncio
    async def test_reap_that_raises_records_failed(self):
        mgr = _make_manager()
        session = _live_session(mgr)
        self._go_idle(session)
        mgr._run_tail_flush = AsyncMock(side_effect=RuntimeError("tail flush blew up"))
        before = _counts()

        await mgr._reap_expired_sessions(timeout_s=60)

        assert _delta(before) == {"failed": 1}


class TestRecovered:
    @pytest.mark.asyncio
    async def test_recovered_session_finalized_normally_records_recovered(self):
        mgr = _make_manager()
        meta = SessionMetadata(
            session_id="rec-1013",
            tenant_id="t1",
            pipeline_id="p1",
            resolved_spec_json=json.dumps(resolved_spec(primary="p1", fallback=None)),
            status=SessionStatus.ACTIVE,
            worker_id="test-worker",
        )
        mgr._redis.scan = AsyncMock(return_value=(0, [b"stt:session:rec-1013"]))
        mgr._redis.hgetall = AsyncMock(return_value=meta.to_redis_dict())
        mgr._redis.exists = AsyncMock(return_value=False)
        mgr._load_pipeline_config = AsyncMock(return_value=None)
        mgr._load_vad_service = AsyncMock(return_value=None)
        mgr._load_asr_pipeline = AsyncMock(return_value=(AsyncMock(), None))
        with (
            patch("stt.streaming.session_manager.IngestionConsumer") as MockConsumer,
            patch("stt.streaming.session_manager.ControlListener") as MockListener,
            patch("stt.streaming.session_manager.ResultPublisher") as MockPublisher,
        ):
            MockConsumer.return_value = AsyncMock()
            MockListener.return_value = AsyncMock()
            MockPublisher.return_value = MagicMock(publish_status=AsyncMock(return_value="0-1"))
            before = _counts()
            await mgr._recover_sessions()
            # Recovery is not a new start: this process never created it.
            assert _delta(before) == {}

            await mgr._finalize_session(mgr._sessions["rec-1013"])

        assert _delta(before) == {"recovered": 1}
