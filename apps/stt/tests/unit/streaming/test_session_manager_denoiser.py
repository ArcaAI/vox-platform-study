"""Unit tests for wiring StreamingDenoiser into session_manager (S2).

Tests:
- Denoiser is created and passed to preprocessor when denoise enabled
- Denoiser skipped when denoise disabled
- Streaming ASR wrapper preserves english_text from the relevant translated segment
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestSessionManagerDenoiserWiring:

    @pytest.mark.asyncio
    async def test_denoiser_created_when_denoise_enabled(self):
        """When pipeline config has denoise.enabled=True, preprocessor should receive a denoiser."""
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
        mgr._switch_controllers = {}
        mgr._provider_overrides = {}
        mgr._fallback_pipeline_ids = {}
        # TASK-985 L-SESSION — instance attrs created in `__init__`, so a
        # `MagicMock(spec=SessionManager)` (which specs off the CLASS) does not
        # carry them. `_creating` holds the ids of sessions mid-creation so the
        # capacity reconciler cannot release a slot during a cold model load;
        # `_empty_decode_streaks` is M-24's empty-with-speech failover counter,
        # cleared by the engine-switch `_apply`.
        mgr._creating = set()
        mgr._empty_decode_streaks = {}

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

        with (
            patch(
                "stt.streaming.session_manager.StreamingDenoiser", return_value=mock_denoiser
            ) as mock_dn_cls,
            patch("stt.streaming.session_manager.StreamingPreprocessor") as mock_pp_cls,
            patch("stt.streaming.session_manager.StreamSession", return_value=mock_session),
            patch("stt.streaming.session_manager.ResultPublisher"),
            patch("stt.streaming.session_manager.IngestionConsumer") as mock_ic,
            patch("stt.streaming.session_manager.ControlListener") as mock_cl,
        ):

            mock_ic.return_value.start = AsyncMock()
            mock_cl.return_value.start = AsyncMock()

            mgr._profile = MagicMock()
            mgr._load_pipeline_config = AsyncMock(return_value=pipeline_config)
            mgr._load_vad_service = AsyncMock(return_value=MagicMock())
            mgr._load_asr_pipeline = AsyncMock(return_value=(MagicMock(), None))
            # Bind the REAL shared assembly (session wiring moved out of
            # create/recover into _assemble_session_runtime).
            mgr._assemble_session_runtime = lambda **kw: SessionManager._assemble_session_runtime(
                mgr, **kw
            )
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
    async def test_deepfilternet3_denoiser_created_when_engine_selected(self):
        """denoise.engine=deepfilternet3 selects the DF3 denoiser,
        not RNNoise's StreamingDenoiser."""
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
        mgr._switch_controllers = {}
        mgr._provider_overrides = {}
        mgr._fallback_pipeline_ids = {}
        # TASK-985 L-SESSION — instance attrs created in `__init__`, so a
        # `MagicMock(spec=SessionManager)` (which specs off the CLASS) does not
        # carry them. `_creating` holds the ids of sessions mid-creation so the
        # capacity reconciler cannot release a slot during a cold model load;
        # `_empty_decode_streaks` is M-24's empty-with-speech failover counter,
        # cleared by the engine-switch `_apply`.
        mgr._creating = set()
        mgr._empty_decode_streaks = {}

        pipeline_config = MagicMock()
        pipeline_config.preprocessing.vad.enabled = True
        pipeline_config.preprocessing.vad.threshold = 0.5
        pipeline_config.preprocessing.vad.min_speech_duration_ms = 250
        pipeline_config.preprocessing.vad.min_silence_duration_ms = 700
        pipeline_config.preprocessing.denoise.enabled = True
        pipeline_config.preprocessing.denoise.strength = 0.8
        pipeline_config.preprocessing.denoise.engine = "deepfilternet3"
        pipeline_config.preprocessing.normalize = True
        pipeline_config.preprocessing.target_sample_rate = 16000
        pipeline_config.diarization.enabled = False

        mock_denoiser = MagicMock()
        mock_denoiser.initialize.return_value = True

        mock_session = MagicMock()
        mock_session.force_persist = AsyncMock()

        with (
            patch(
                "stt.streaming.session_manager.DeepFilterNet3StreamingDenoiser",
                return_value=mock_denoiser,
            ) as mock_df3_cls,
            patch("stt.streaming.session_manager.StreamingDenoiser") as mock_rnnoise_cls,
            patch("stt.streaming.session_manager.StreamingPreprocessor") as mock_pp_cls,
            patch("stt.streaming.session_manager.StreamSession", return_value=mock_session),
            patch("stt.streaming.session_manager.ResultPublisher"),
            patch("stt.streaming.session_manager.IngestionConsumer") as mock_ic,
            patch("stt.streaming.session_manager.ControlListener") as mock_cl,
        ):

            mock_ic.return_value.start = AsyncMock()
            mock_cl.return_value.start = AsyncMock()

            mgr._profile = MagicMock()
            mgr._load_pipeline_config = AsyncMock(return_value=pipeline_config)
            mgr._load_vad_service = AsyncMock(return_value=MagicMock())
            mgr._load_asr_pipeline = AsyncMock(return_value=(MagicMock(), None))
            mgr._assemble_session_runtime = lambda **kw: SessionManager._assemble_session_runtime(
                mgr, **kw
            )
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
                session_id="s1",
                tenant_id="t1",
                pipeline_id="p1",
                sample_rate=16000,
            )

            mock_df3_cls.assert_called_once_with(input_sr=16000, strength=0.8)
            mock_rnnoise_cls.assert_not_called()
            mock_denoiser.initialize.assert_called_once()

            pp_call = mock_pp_cls.call_args
            assert pp_call.kwargs.get("denoiser") is mock_denoiser

    @pytest.mark.asyncio
    async def test_deepfilternet3_unavailable_fails_the_session_closed(self):
        """TASK-860 R-5: a selected deepfilternet3 whose package is absent
        FAILS the session with ModelLoadError — never a silent no-op denoiser
        and never a degrade to no denoiser."""
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
        mgr._switch_controllers = {}
        mgr._provider_overrides = {}
        mgr._fallback_pipeline_ids = {}
        # TASK-985 L-SESSION — instance attrs created in `__init__`, so a
        # `MagicMock(spec=SessionManager)` (which specs off the CLASS) does not
        # carry them. `_creating` holds the ids of sessions mid-creation so the
        # capacity reconciler cannot release a slot during a cold model load;
        # `_empty_decode_streaks` is M-24's empty-with-speech failover counter,
        # cleared by the engine-switch `_apply`.
        mgr._creating = set()
        mgr._empty_decode_streaks = {}

        pipeline_config = MagicMock()
        pipeline_config.preprocessing.vad.enabled = True
        pipeline_config.preprocessing.vad.threshold = 0.5
        pipeline_config.preprocessing.vad.min_speech_duration_ms = 250
        pipeline_config.preprocessing.vad.min_silence_duration_ms = 700
        pipeline_config.preprocessing.denoise.enabled = True
        pipeline_config.preprocessing.denoise.strength = 0.8
        pipeline_config.preprocessing.denoise.engine = "deepfilternet3"
        pipeline_config.preprocessing.normalize = True
        pipeline_config.preprocessing.target_sample_rate = 16000
        pipeline_config.diarization.enabled = False

        from stt.core.exceptions import ModelLoadError

        mock_denoiser = MagicMock()
        mock_denoiser.initialize.side_effect = ModelLoadError("deepfilternet3 not installed")

        mock_session = MagicMock()
        mock_session.force_persist = AsyncMock()

        with (
            patch(
                "stt.streaming.session_manager.DeepFilterNet3StreamingDenoiser",
                return_value=mock_denoiser,
            ) as mock_df3_cls,
            patch("stt.streaming.session_manager.StreamingDenoiser") as mock_rnnoise_cls,
            patch("stt.streaming.session_manager.StreamingPreprocessor") as mock_pp_cls,
            patch("stt.streaming.session_manager.StreamSession", return_value=mock_session),
            patch("stt.streaming.session_manager.ResultPublisher"),
            patch("stt.streaming.session_manager.IngestionConsumer") as mock_ic,
            patch("stt.streaming.session_manager.ControlListener") as mock_cl,
        ):

            mock_ic.return_value.start = AsyncMock()
            mock_cl.return_value.start = AsyncMock()

            mgr._profile = MagicMock()
            mgr._load_pipeline_config = AsyncMock(return_value=pipeline_config)
            mgr._load_vad_service = AsyncMock(return_value=MagicMock())
            mgr._load_asr_pipeline = AsyncMock(return_value=(MagicMock(), None))
            mgr._assemble_session_runtime = lambda **kw: SessionManager._assemble_session_runtime(
                mgr, **kw
            )
            mgr._redis = AsyncMock()
            mgr._worker_id = "test-worker"
            mgr._capacity_guard = MagicMock()
            mgr._capacity_guard.try_acquire = AsyncMock(return_value=True)
            mgr._register_inference_runtime = MagicMock()
            mgr._make_frame_handler = MagicMock(return_value=lambda x: None)
            mgr._make_control_handler = MagicMock(return_value=lambda x: None)
            mgr._make_commit_policy = MagicMock(return_value=None)
            mgr.remove_session = AsyncMock()

            with pytest.raises(ModelLoadError, match="deepfilternet3"):
                await SessionManager.create_session(
                    mgr,
                    session_id="s1",
                    tenant_id="t1",
                    pipeline_id="p1",
                    sample_rate=16000,
                )

            mock_df3_cls.assert_called_once_with(input_sr=16000, strength=0.8)
            mock_rnnoise_cls.assert_not_called()
            # The session never reached the preprocessor with a no-op denoiser.
            mock_pp_cls.assert_not_called()

    @pytest.mark.asyncio
    async def test_denoiser_skipped_when_disabled(self):
        """When denoise.enabled=False, no denoiser should be created."""
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
        mgr._switch_controllers = {}
        mgr._provider_overrides = {}
        mgr._fallback_pipeline_ids = {}
        # TASK-985 L-SESSION — instance attrs created in `__init__`, so a
        # `MagicMock(spec=SessionManager)` (which specs off the CLASS) does not
        # carry them. `_creating` holds the ids of sessions mid-creation so the
        # capacity reconciler cannot release a slot during a cold model load;
        # `_empty_decode_streaks` is M-24's empty-with-speech failover counter,
        # cleared by the engine-switch `_apply`.
        mgr._creating = set()
        mgr._empty_decode_streaks = {}

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

        with (
            patch("stt.streaming.session_manager.StreamingDenoiser") as mock_dn_cls,
            patch("stt.streaming.session_manager.StreamingPreprocessor") as mock_pp_cls,
            patch("stt.streaming.session_manager.StreamSession", return_value=mock_session),
            patch("stt.streaming.session_manager.ResultPublisher"),
            patch("stt.streaming.session_manager.IngestionConsumer") as mock_ic,
            patch("stt.streaming.session_manager.ControlListener") as mock_cl,
        ):

            mock_ic.return_value.start = AsyncMock()
            mock_cl.return_value.start = AsyncMock()

            mgr._profile = MagicMock()
            mgr._load_pipeline_config = AsyncMock(return_value=pipeline_config)
            mgr._load_vad_service = AsyncMock(return_value=MagicMock())
            mgr._load_asr_pipeline = AsyncMock(return_value=(MagicMock(), None))
            # Bind the REAL shared assembly (session wiring moved out of
            # create/recover into _assemble_session_runtime).
            mgr._assemble_session_runtime = lambda **kw: SessionManager._assemble_session_runtime(
                mgr, **kw
            )
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

    @pytest.mark.asyncio
    async def test_voice_profiles_are_seeded_for_a_session_with_no_consultation(self):
        """TASK-887 — seeding is driven by the SESSION, not by a consultation lookup.

        The old preseed resolved the consultation's doctor out of Postgres, so a session
        without a consultation id needed the `user_id` branch to reach a profile at all. The
        gateway now pushes the profiles it already resolved, so there is nothing to look up
        and no branch to take."""
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
        mgr._switch_controllers = {}
        mgr._provider_overrides = {}
        mgr._session_voice_profiles = {}
        mgr._session_voice_profile_seeded = {}  # TASK-991 sibling map
        mgr._fallback_pipeline_ids = {}
        # TASK-985 L-SESSION — instance attrs created in `__init__`, so a
        # `MagicMock(spec=SessionManager)` (which specs off the CLASS) does not
        # carry them. `_creating` holds the ids of sessions mid-creation so the
        # capacity reconciler cannot release a slot during a cold model load;
        # `_empty_decode_streaks` is M-24's empty-with-speech failover counter,
        # cleared by the engine-switch `_apply`.
        mgr._creating = set()
        mgr._empty_decode_streaks = {}

        pipeline_config = MagicMock()
        pipeline_config.preprocessing.vad.enabled = True
        pipeline_config.preprocessing.vad.threshold = 0.5
        pipeline_config.preprocessing.vad.min_speech_duration_ms = 250
        pipeline_config.preprocessing.vad.min_silence_duration_ms = 700
        pipeline_config.preprocessing.denoise.enabled = False
        pipeline_config.preprocessing.normalize = False
        pipeline_config.preprocessing.target_sample_rate = 16000
        pipeline_config.diarization.enabled = True
        pipeline_config.diarization.backend = "embedding"
        pipeline_config.diarization.max_speakers = 5
        pipeline_config.diarization.max_embeddings_per_speaker = 5
        pipeline_config.diarization.enable_segmentation_refinement = False
        pipeline_config.inference.initial_prompt = None
        pipeline_config.postprocessing = None

        mock_session = MagicMock()
        mock_session.force_persist = AsyncMock()

        with (
            patch("stt.streaming.session_manager.StreamingPreprocessor"),
            patch("stt.streaming.session_manager.StreamSession", return_value=mock_session),
            patch("stt.streaming.session_manager.ResultPublisher"),
            patch("stt.streaming.session_manager.IngestionConsumer") as mock_ic,
            patch("stt.streaming.session_manager.ControlListener") as mock_cl,
            patch("stt.diarization.speaker_tracker.SpeakerTracker") as mock_tracker_cls,
            patch("stt.diarization.speaker_identifier.SpeakerIdentifier"),
        ):

            mock_ic.return_value.start = AsyncMock()
            mock_cl.return_value.start = AsyncMock()

            mock_tracker = MagicMock()
            mock_tracker_cls.return_value = mock_tracker

            mgr._profile = MagicMock()
            mgr._load_pipeline_config = AsyncMock(return_value=pipeline_config)
            mgr._load_vad_service = AsyncMock(return_value=MagicMock())
            mgr._load_asr_pipeline = AsyncMock(return_value=(MagicMock(), None))
            # Bind the REAL shared assembly (session wiring moved out of
            # create/recover into _assemble_session_runtime).
            mgr._assemble_session_runtime = lambda **kw: SessionManager._assemble_session_runtime(
                mgr, **kw
            )
            mgr._redis = AsyncMock()
            mgr._worker_id = "test-worker"
            mgr._capacity_guard = MagicMock()
            mgr._capacity_guard.try_acquire = AsyncMock(return_value=True)
            mgr._register_inference_runtime = MagicMock()
            mgr._make_frame_handler = MagicMock(return_value=lambda x: None)
            mgr._make_control_handler = MagicMock(return_value=lambda x: None)
            mgr._make_commit_policy = MagicMock(return_value=None)
            mgr.remove_session = AsyncMock()
            mgr._spec_embedding_slug = MagicMock(return_value="wespeaker-voxceleb-resnet34")

            profiles = [
                {
                    "profile_id": "vp-1",
                    "label": "Dr Who",
                    "model_id": "wespeaker-voxceleb-resnet34",
                    "embedding": [0.1],
                }
            ]
            await SessionManager.create_session(
                mgr,
                session_id="s1",
                tenant_id="t1",
                pipeline_id="p1",
                consultation_id=None,
                sample_rate=16000,
                user_id="user-1",
                voice_profiles=profiles,
            )

            # The session tracker is seeded with the pushed profiles, scoped to the model
            # the agent bound — no consultation, no database, no branch.
            mgr._seed_voice_profiles.assert_called_once_with(
                mock_tracker,
                "s1",
                "wespeaker-voxceleb-resnet34",
            )
            assert mgr._session_voice_profiles["s1"] == profiles
