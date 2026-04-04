"""Unit tests for wiring StreamingDenoiser into session_manager (S2).

Tests:
- Denoiser is created and passed to preprocessor when denoise enabled
- Denoiser skipped when denoise disabled
"""

from unittest.mock import AsyncMock, MagicMock, patch
import pytest


class TestSessionManagerDenoiserWiring:

    @pytest.mark.asyncio
    async def test_denoiser_created_when_denoise_enabled(self):
        """When pipeline config has denoise.enabled=True, preprocessor should receive a denoiser."""
        from stt_v2.streaming.session_manager import SessionManager

        mgr = MagicMock(spec=SessionManager)
        mgr._sessions = {}
        mgr._consumers = {}
        mgr._control_listeners = {}
        mgr._publishers = {}
        mgr._preprocessors = {}
        mgr._inference_workers = {}

        pipeline_config = MagicMock()
        pipeline_config.preprocessing.vad.enabled = True
        pipeline_config.preprocessing.vad.threshold = 0.5
        pipeline_config.preprocessing.vad.min_speech_duration_ms = 250
        pipeline_config.preprocessing.vad.min_silence_duration_ms = 700
        pipeline_config.preprocessing.denoise.enabled = True
        pipeline_config.preprocessing.denoise.strength = 0.8
        pipeline_config.preprocessing.normalize = True
        pipeline_config.preprocessing.target_sample_rate = 16000
        pipeline_config.diarization.enabled = False

        mock_denoiser = MagicMock()
        mock_denoiser.initialize.return_value = True

        mock_session = MagicMock()
        mock_session.force_persist = AsyncMock()

        with patch("stt_v2.streaming.session_manager.StreamingDenoiser", return_value=mock_denoiser) as mock_dn_cls, \
             patch("stt_v2.streaming.session_manager.StreamingPreprocessor") as mock_pp_cls, \
             patch("stt_v2.streaming.session_manager.StreamSession", return_value=mock_session), \
             patch("stt_v2.streaming.session_manager.ResultPublisher"), \
             patch("stt_v2.streaming.session_manager.IngestionConsumer") as mock_ic, \
             patch("stt_v2.streaming.session_manager.ControlListener") as mock_cl:

            mock_ic.return_value.start = AsyncMock()
            mock_cl.return_value.start = AsyncMock()

            mgr._profile = MagicMock()
            mgr._profile.denoise_enabled_default = False
            mgr._load_pipeline_config = AsyncMock(return_value=pipeline_config)
            mgr._load_vad_service = AsyncMock(return_value=MagicMock())
            mgr._load_asr_pipeline = AsyncMock(return_value=MagicMock())
            mgr._redis = AsyncMock()
            mgr._worker_id = "test-worker"
            mgr._capacity_guard = MagicMock()
            mgr._capacity_guard.try_acquire = AsyncMock(return_value=True)
            mgr._register_inference_runtime = MagicMock()
            mgr._make_frame_handler = MagicMock(return_value=lambda x: None)
            mgr._make_control_handler = MagicMock(return_value=lambda x: None)
            mgr.remove_session = AsyncMock()

            await SessionManager.create_session(
                mgr,
                session_id="s1",
                tenant_id="t1",
                pipeline_id="p1",
                sample_rate=16000,
            )

            # StreamingDenoiser created with correct strength
            mock_dn_cls.assert_called_once_with(input_sr=16000, strength=0.8)
            mock_denoiser.initialize.assert_called_once()

            # Preprocessor received denoiser
            pp_call = mock_pp_cls.call_args
            assert pp_call.kwargs.get("denoiser") is mock_denoiser

    @pytest.mark.asyncio
    async def test_denoiser_skipped_when_disabled(self):
        """When denoise.enabled=False, no denoiser should be created."""
        from stt_v2.streaming.session_manager import SessionManager

        mgr = MagicMock(spec=SessionManager)
        mgr._sessions = {}
        mgr._consumers = {}
        mgr._control_listeners = {}
        mgr._publishers = {}
        mgr._preprocessors = {}
        mgr._inference_workers = {}

        pipeline_config = MagicMock()
        pipeline_config.preprocessing.vad.enabled = True
        pipeline_config.preprocessing.vad.threshold = 0.5
        pipeline_config.preprocessing.vad.min_speech_duration_ms = 250
        pipeline_config.preprocessing.vad.min_silence_duration_ms = 700
        pipeline_config.preprocessing.denoise.enabled = False
        pipeline_config.preprocessing.normalize = False
        pipeline_config.preprocessing.target_sample_rate = 16000
        pipeline_config.diarization.enabled = False

        mock_session = MagicMock()
        mock_session.force_persist = AsyncMock()

        with patch("stt_v2.streaming.session_manager.StreamingDenoiser") as mock_dn_cls, \
             patch("stt_v2.streaming.session_manager.StreamingPreprocessor") as mock_pp_cls, \
             patch("stt_v2.streaming.session_manager.StreamSession", return_value=mock_session), \
             patch("stt_v2.streaming.session_manager.ResultPublisher"), \
             patch("stt_v2.streaming.session_manager.IngestionConsumer") as mock_ic, \
             patch("stt_v2.streaming.session_manager.ControlListener") as mock_cl:

            mock_ic.return_value.start = AsyncMock()
            mock_cl.return_value.start = AsyncMock()

            mgr._profile = MagicMock()
            mgr._profile.denoise_enabled_default = False
            mgr._load_pipeline_config = AsyncMock(return_value=pipeline_config)
            mgr._load_vad_service = AsyncMock(return_value=MagicMock())
            mgr._load_asr_pipeline = AsyncMock(return_value=MagicMock())
            mgr._redis = AsyncMock()
            mgr._worker_id = "test-worker"
            mgr._capacity_guard = MagicMock()
            mgr._capacity_guard.try_acquire = AsyncMock(return_value=True)
            mgr._register_inference_runtime = MagicMock()
            mgr._make_frame_handler = MagicMock(return_value=lambda x: None)
            mgr._make_control_handler = MagicMock(return_value=lambda x: None)
            mgr.remove_session = AsyncMock()

            await SessionManager.create_session(
                mgr,
                session_id="s1",
                tenant_id="t1",
                pipeline_id="p1",
                sample_rate=16000,
            )

            # StreamingDenoiser should NOT have been instantiated
            mock_dn_cls.assert_not_called()

            # Preprocessor should have denoiser=None
            pp_call = mock_pp_cls.call_args
            assert pp_call.kwargs.get("denoiser") is None
