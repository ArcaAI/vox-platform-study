"""Streaming preseed carries tenant_id end-to-end.

(The user-id-without-consultation preseed wiring test lives in
``test_session_manager_denoiser.py``; its call-shape assertion was updated for
the tenant_id kwarg.)

The streaming voice-profile preseed used to drop ``tenant_id``:
``create_session`` called ``self._preseed_speaker(...)`` without the session
tenant, so the voice-profile lookups could not be tenant-scoped. These tests
lock the chain:

  create_session -> _preseed_speaker(tenant_id=...) -> preseed_speaker(tenant_id=...)

(the ``preseed_speaker -> DB lookups`` hop is locked in
``tests/unit/diarization/test_preseed.py``.)
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_preseed_wrapper_forwards_tenant_id():
    """SessionManager._preseed_speaker forwards tenant_id to preseed_speaker."""
    from stt.streaming.session_manager import SessionManager

    mgr = MagicMock(spec=SessionManager)
    tracker = MagicMock()

    with patch(
        "stt.diarization.preseed.preseed_speaker", new=AsyncMock()
    ) as mock_preseed:
        await SessionManager._preseed_speaker(
            mgr,
            tracker,
            "cons-1",
            "sess-1",
            tenant_id="tenant-a",
            user_id="user-1",
        )

    mock_preseed.assert_awaited_once()
    kwargs = mock_preseed.await_args.kwargs
    assert kwargs.get("tenant_id") == "tenant-a"
    assert kwargs.get("user_id") == "user-1"
    assert kwargs.get("log_context") == "sess-1"


@pytest.mark.asyncio
async def test_create_session_passes_tenant_to_preseed():
    """create_session hands the session tenant to the preseed call site."""
    from stt.streaming.session_manager import SessionManager

    mgr = MagicMock(spec=SessionManager)
    mgr._sessions = {}
    mgr._consumers = {}
    mgr._control_listeners = {}
    mgr._publishers = {}
    mgr._preprocessors = {}
    mgr._inference_workers = {}
    mgr._dual_capture = {}
    mgr._commit_policies = {}

    pipeline_config = MagicMock()
    pipeline_config.preprocessing.vad.enabled = True
    pipeline_config.preprocessing.vad.threshold = 0.5
    pipeline_config.preprocessing.vad.min_speech_duration_ms = 250
    pipeline_config.preprocessing.vad.min_silence_duration_ms = 700
    pipeline_config.preprocessing.denoise.enabled = False
    pipeline_config.preprocessing.normalize = False
    pipeline_config.preprocessing.target_sample_rate = 16000
    pipeline_config.diarization.enabled = True
    pipeline_config.diarization.max_speakers = 2
    pipeline_config.diarization.max_embeddings_per_speaker = 5
    pipeline_config.diarization.enable_segmentation_refinement = False

    mock_session = MagicMock()
    mock_session.force_persist = AsyncMock()

    with (
        patch("stt.streaming.session_manager.StreamSession", return_value=mock_session),
        patch("stt.streaming.session_manager.ResultPublisher"),
        patch("stt.streaming.session_manager.StreamingPreprocessor"),
        patch("stt.streaming.session_manager.StreamingInferenceWorker"),
        patch("stt.streaming.session_manager.IngestionConsumer") as mock_ic,
        patch("stt.streaming.session_manager.ControlListener") as mock_cl,
        patch("stt.diarization.speaker_tracker.SpeakerTracker") as mock_tracker_cls,
        patch("stt.diarization.speaker_identifier.SpeakerIdentifier"),
        patch("stt.diarization.embedding_service.get_embedding_service"),
    ):
        mock_ic.return_value.start = AsyncMock()
        mock_cl.return_value.start = AsyncMock()

        mgr._profile = MagicMock()
        mgr._profile.denoise_enabled_default = False
        mgr._load_pipeline_config = AsyncMock(return_value=pipeline_config)
        mgr._load_vad_service = AsyncMock(return_value=MagicMock())
        mgr._load_asr_pipeline = AsyncMock(return_value=(MagicMock(), None))
        # Bind the REAL shared assembly (session wiring moved out of
        # create/recover into _assemble_session_runtime).
        mgr._assemble_session_runtime = (
            lambda **kw: SessionManager._assemble_session_runtime(mgr, **kw)
        )
        mgr._load_gloss_pipeline = AsyncMock(return_value=None)
        mgr._preseed_speaker = AsyncMock()
        mgr._redis = AsyncMock()
        mgr._worker_id = "test-worker"
        mgr._capacity_guard = MagicMock()
        mgr._capacity_guard.try_acquire = AsyncMock(return_value=True)
        mgr._register_inference_runtime = MagicMock()
        mgr._make_frame_handler = MagicMock(return_value=lambda x: None)
        mgr._make_control_handler = MagicMock(return_value=lambda x: None)
        mgr._make_commit_policy = MagicMock(return_value=None)
        mgr.remove_session = AsyncMock()

        await SessionManager.create_session(
            mgr,
            session_id="sess-1",
            tenant_id="tenant-a",
            pipeline_id="p1",
            consultation_id="cons-1",
            sample_rate=16000,
            user_id="user-1",
        )

    mgr._preseed_speaker.assert_awaited_once()
    args = mgr._preseed_speaker.await_args
    assert args.args[0] is mock_tracker_cls.return_value  # the session tracker
    assert args.kwargs.get("tenant_id") == "tenant-a"  # tenant threaded through
    assert args.kwargs.get("user_id") == "user-1"
