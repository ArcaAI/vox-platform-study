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
from prometheus_client import REGISTRY


def _metric(name: str, labels: dict[str, str]) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


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

    def test_records_the_streaming_audio_duration_and_rtf_metrics(self):
        """TASK-615 WS-C — the current-state review's telemetry gap: streaming
        had no audio-duration signal in Prometheus and no RTF at all."""
        from stt.pipeline.dto import AiModelFormat
        from stt.streaming.inference import StreamingInferenceWorker

        mgr = _make_manager()
        session = _make_session()
        session._metadata.total_duration_seconds = 40.0
        session._metadata.closed_at = session._metadata.created_at
        mgr._session_asr_formats[session.session_id] = AiModelFormat.WHISPER_CPP
        worker = StreamingInferenceWorker()
        worker.cumulative_processing_seconds = 10.0
        mgr._inference_workers[session.session_id] = worker

        labels = {"pipeline": "p1", "engine": "whisper_cpp", "status": "closed"}
        before_audio_count = _metric("stt_streaming_audio_duration_seconds_count", labels)
        before_rtf_sum = _metric("stt_streaming_rtf_sum", labels)

        mgr._build_teardown_summary(session)

        assert (
            _metric("stt_streaming_audio_duration_seconds_count", labels) == before_audio_count + 1
        )
        # RTF = processing_seconds / audio_seconds = 10/40 = 0.25.
        assert _metric("stt_streaming_rtf_sum", labels) == pytest.approx(before_rtf_sum + 0.25)

    def test_records_metrics_with_unknown_engine_when_none_resolved(self):
        """No ASR model ever loaded -> engine stays None in the summary, but
        the metric label must still be a bounded, non-empty value."""
        mgr = _make_manager()
        session = _make_session()
        session._metadata.total_duration_seconds = 5.0
        session._metadata.closed_at = session._metadata.created_at

        labels = {"pipeline": "p1", "engine": "unknown", "status": "closed"}
        before = _metric("stt_streaming_audio_duration_seconds_count", labels)

        mgr._build_teardown_summary(session)

        assert _metric("stt_streaming_audio_duration_seconds_count", labels) == before + 1

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

    def test_platform_funded_cloud_engine_meters_as_cloud(self):
        """TASK-643 R3 — a gateway-injected SYSTEM-tenant credential is
        indistinguishable from the tenant's own on the wire, so `funding`
        declares which. Platform-funded must meter as CLOUD: BYOK would zero
        its COGS contribution and rate it at baseline SELL, never invoiced."""
        from stt.pipeline.dto import AiModelFormat

        mgr = _make_manager()
        session = _make_session()
        session._metadata.closed_at = session._metadata.created_at
        mgr._session_asr_formats[session.session_id] = AiModelFormat.AZURE_SPEECH
        mgr._provider_overrides[session.session_id] = {
            "azure-speech": {"apiKey": "platform-key", "funding": "platform"}
        }

        summary = mgr._build_teardown_summary(session)

        assert summary["engine"] == "azure-speech"
        assert summary["deployment"] == "CLOUD"

    def test_tenant_funded_cloud_engine_meters_as_byok(self):
        from stt.pipeline.dto import AiModelFormat

        mgr = _make_manager()
        session = _make_session()
        session._metadata.closed_at = session._metadata.created_at
        mgr._session_asr_formats[session.session_id] = AiModelFormat.AZURE_SPEECH
        mgr._provider_overrides[session.session_id] = {
            "azure-speech": {"apiKey": "tenant-key", "funding": "tenant"}
        }

        summary = mgr._build_teardown_summary(session)

        assert summary["deployment"] == "BYOK"

    def test_override_for_a_different_provider_does_not_attribute(self):
        """The pre-R3 predicate was dict-truthy over the WHOLE override map, so
        a tenant holding only a Sarvam key had its Azure-Speech call marked
        BYOK. The serving engine's own entry is the only one that counts."""
        from stt.pipeline.dto import AiModelFormat

        mgr = _make_manager()
        session = _make_session()
        session._metadata.closed_at = session._metadata.created_at
        mgr._session_asr_formats[session.session_id] = AiModelFormat.AZURE_SPEECH
        mgr._provider_overrides[session.session_id] = {"sarvam": {"apiKey": "tenant-sarvam-key"}}

        summary = mgr._build_teardown_summary(session)

        assert summary["engine"] == "azure-speech"
        # No azure-speech entry -> the call ran on a platform credential.
        assert summary["deployment"] == "CLOUD"

    def test_each_provider_entry_is_attributed_on_its_own_funding(self):
        """A mixed map: platform-funded Azure alongside a tenant-funded Sarvam.
        Whichever engine actually served the session decides, independently."""
        from stt.pipeline.dto import AiModelFormat

        overrides = {
            "azure-speech": {"apiKey": "platform-key", "funding": "platform"},
            "sarvam": {"apiKey": "tenant-key", "funding": "tenant"},
        }

        mgr = _make_manager()
        azure_session = _make_session(session_id="sess_azure")
        azure_session._metadata.closed_at = azure_session._metadata.created_at
        mgr._session_asr_formats[azure_session.session_id] = AiModelFormat.AZURE_SPEECH
        mgr._provider_overrides[azure_session.session_id] = dict(overrides)

        sarvam_session = _make_session(session_id="sess_sarvam")
        sarvam_session._metadata.closed_at = sarvam_session._metadata.created_at
        mgr._session_asr_formats[sarvam_session.session_id] = AiModelFormat.SARVAM
        mgr._provider_overrides[sarvam_session.session_id] = dict(overrides)

        assert mgr._build_teardown_summary(azure_session)["deployment"] == "CLOUD"
        assert mgr._build_teardown_summary(sarvam_session)["deployment"] == "BYOK"

    def test_funding_survives_the_request_schema_and_the_shallow_copy(self):
        """The label is only useful if it reaches `_build_teardown_summary`
        unchanged: `provider_overrides` is typed `dict[str, Any]` (pydantic
        does not model — and so cannot strip — the per-entry fields), and
        `create_session` stores `dict(provider_overrides or {})`, a SHALLOW
        copy whose values are the same nested dicts."""
        from stt.pipeline.dto import AiModelFormat
        from stt.streaming.api.schemas import CreateStreamingSessionRequest

        request = CreateStreamingSessionRequest(
            session_id="sess_wire",
            tenant_id="t1",
            pipeline_id="p1",
            provider_overrides={
                "azure-speech": {
                    "apiKey": "platform-key",
                    "region": "eastus",
                    "funding": "platform",
                }
            },
        )
        assert request.provider_overrides is not None
        assert request.provider_overrides["azure-speech"]["funding"] == "platform"

        mgr = _make_manager()
        session = _make_session(session_id="sess_wire")
        session._metadata.closed_at = session._metadata.created_at
        mgr._session_asr_formats[session.session_id] = AiModelFormat.AZURE_SPEECH
        # Exactly what create_session stores (session_manager.py:902).
        mgr._provider_overrides[session.session_id] = dict(request.provider_overrides or {})

        assert mgr._build_teardown_summary(session)["deployment"] == "CLOUD"

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
