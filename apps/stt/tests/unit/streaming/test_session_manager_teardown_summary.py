"""TASK-615 WS-C — streaming session teardown builds a usage-attribution summary.

`SessionManager._finalize_session_locked` (called by `end_session`, in turn
called by the DELETE /internal/streaming/sessions/{id} route on EVERY
teardown — complete AND abort alike, since STT itself has no concept of
"interrupted") must return a summary carrying everything the API Gateway
needs to emit the `transcribe.stream` ledger row: audio seconds, wall-clock
session seconds, and the (engine, deployment) pair resolved from the ASR
model actually loaded for the session (stamped in `_load_asr_pipeline`,
TASK-567's `_session_asr_formats` map — the SAME choke point used for BOTH
session-create and every engine switch, so it can never go stale).

STT does not distinguish complete vs abort at all — that is a
GATEWAY-side concept (which code path called removeSession). This summary
is identical either way; the gateway is what decides `interrupted`.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest


def _make_session(
    session_id: str = "sess_teardown",
    tenant_id: str = "t1",
    consultation_id: str | None = "c1",
    user_id: str | None = "u1",
    sample_rate: int = 16000,
):
    from stt.streaming.schemas import SessionMetadata, SessionStatus
    from stt.streaming.session import StreamSession

    meta = SessionMetadata(
        session_id=session_id,
        tenant_id=tenant_id,
        pipeline_id="p1",
        consultation_id=consultation_id,
        user_id=user_id,
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


class TestBuildTeardownSummary:
    def test_self_hosted_engine_summary(self):
        from stt.pipeline.dto import AiModelFormat

        mgr = _make_manager()
        session = _make_session()
        session._metadata.total_duration_seconds = 42.5
        session._metadata.created_at = "2026-08-06T10:00:00"
        session._metadata.closed_at = "2026-08-06T10:01:30"  # +90s wall clock
        mgr._session_asr_formats[session.session_id] = AiModelFormat.WHISPER_CPP
        mgr._session_language_modes[session.session_id] = "ml-en"

        summary = mgr._build_teardown_summary(session)

        assert summary["session_id"] == session.session_id
        assert summary["tenant_id"] == "t1"
        assert summary["consultation_id"] == "c1"
        assert summary["user_id"] == "u1"
        assert summary["pipeline_id"] == "p1"
        assert summary["closed_at"] == "2026-08-06T10:01:30"
        assert summary["audio_seconds"] == 42.5
        assert summary["session_seconds"] == pytest.approx(90.0)
        assert summary["engine"] == "whisper_cpp"
        assert summary["deployment"] == "SELF_HOSTED"
        assert summary["language_mode"] == "ml-en"

    def test_byok_cloud_engine_summary(self):
        from stt.pipeline.dto import AiModelFormat

        mgr = _make_manager()
        session = _make_session()
        session._metadata.closed_at = session._metadata.created_at
        mgr._session_asr_formats[session.session_id] = AiModelFormat.AZURE_SPEECH
        mgr._provider_overrides[session.session_id] = {"azure-speech": {"apiKey": "tenant-key"}}

        summary = mgr._build_teardown_summary(session)

        assert summary["engine"] == "azure-speech"
        assert summary["deployment"] == "BYOK"

    def test_no_asr_format_tracked_yields_no_engine(self):
        """A session that never resolved an ASR model (e.g. it failed before
        load) must not fabricate an engine — the gateway skips ledger
        emission when engine is None, exactly like the batch path."""
        mgr = _make_manager()
        session = _make_session()
        session._metadata.closed_at = session._metadata.created_at

        summary = mgr._build_teardown_summary(session)

        assert summary["engine"] is None
        assert summary["deployment"] is None

    def test_missing_closed_at_yields_zero_session_seconds(self):
        """Defensive: session_seconds must never raise or go negative when
        closed_at has not been stamped yet (should not happen in practice —
        `close()` always sets it before this is called — but a summary must
        degrade to 0.0, never throw, since metering must never block
        teardown)."""
        mgr = _make_manager()
        session = _make_session()
        session._metadata.closed_at = None

        summary = mgr._build_teardown_summary(session)

        assert summary["session_seconds"] == 0.0
        # closed_at (the ledger occurredAt) still gets a real ISO stamp —
        # the summary is never returned with a missing required field.
        assert summary["closed_at"]


class TestFinalizeReturnsTeardownSummary:
    @pytest.mark.asyncio
    async def test_end_session_returns_the_summary(self):
        """Full integration through end_session() -> _finalize_session_locked()."""
        from stt.pipeline.dto import AiModelFormat

        mgr = _make_manager()
        session = _make_session()
        session._metadata.total_duration_seconds = 7.0
        mgr._sessions[session.session_id] = session
        mgr._session_asr_formats[session.session_id] = AiModelFormat.FASTER_WHISPER

        # Stub every durability side effect so this test exercises ONLY the
        # summary-building — not blob upload / dual-capture / transcript
        # persistence, which the finalize-ordering suite already covers.
        mgr._blob_service = MagicMock()
        mgr._register_dual_capture = AsyncMock()
        mgr._persist_streaming_transcript = AsyncMock()

        summary = await mgr.end_session(session.session_id)

        assert summary is not None
        assert summary["session_id"] == session.session_id
        assert summary["audio_seconds"] == 7.0
        assert summary["engine"] == "faster_whisper"
        assert summary["deployment"] == "SELF_HOSTED"
        # session_seconds is non-negative wall clock (created_at -> closed_at,
        # both stamped within this fast-running test).
        assert summary["session_seconds"] >= 0.0

    @pytest.mark.asyncio
    async def test_end_session_on_unknown_session_returns_none(self):
        mgr = _make_manager()
        result = await mgr.end_session("does-not-exist")
        assert result is None
