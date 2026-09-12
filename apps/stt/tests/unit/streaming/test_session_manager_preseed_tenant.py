"""Streaming voice-profile seeding is gateway-fed and model-scoped (TASK-887).

The old chain read the consultation's doctor and their embedding out of Postgres, and these
tests locked `tenant_id` through it so the lookups were tenant-scoped. Diarization is now a
declared ASR-agent option and the gateway pushes the profiles, so the chain — and what has to
be locked — is different:

  create_session(voice_profiles=…) -> per-session stash -> _assemble_session_runtime
      -> _seed_voice_profiles(tracker, session_id, <the agent's embedding SLUG>)
      -> seed_voice_profiles(...)

(the `seed_voice_profiles -> tracker` hop is locked in `tests/unit/diarization/test_preseed.py`.)
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

PROFILES = [
    {
        "profile_id": "vp-1",
        "label": "Dr Who",
        "model_id": "wespeaker-voxceleb-resnet34",
        "embedding": [0.1, 0.2],
    }
]


def test_seed_wrapper_forwards_the_session_profiles_and_the_model_slug():
    """`SessionManager._seed_voice_profiles` hands the stashed profiles to the pure helper."""
    from stt.streaming.session_manager import SessionManager

    mgr = MagicMock(spec=SessionManager)
    mgr._session_voice_profiles = {"sess-1": PROFILES}
    tracker = MagicMock()

    with patch("stt.diarization.preseed.seed_voice_profiles") as mock_seed:
        SessionManager._seed_voice_profiles(mgr, tracker, "sess-1", "wespeaker-voxceleb-resnet34")

    mock_seed.assert_called_once()
    args, kwargs = mock_seed.call_args
    assert args[0] is tracker
    assert args[1] == PROFILES
    assert kwargs["model_slug"] == "wespeaker-voxceleb-resnet34"
    assert kwargs["log_context"] == "sess-1"


def test_seed_wrapper_passes_none_for_a_session_that_was_pushed_nothing():
    from stt.streaming.session_manager import SessionManager

    mgr = MagicMock(spec=SessionManager)
    mgr._session_voice_profiles = {}

    with patch("stt.diarization.preseed.seed_voice_profiles") as mock_seed:
        SessionManager._seed_voice_profiles(
            mgr, MagicMock(), "sess-1", "wespeaker-voxceleb-resnet34"
        )

    assert mock_seed.call_args.args[1] is None


def test_spec_embedding_slug_reads_the_reference_the_profiles_are_matched_against():
    from types import SimpleNamespace

    from stt.streaming.session_manager import SessionManager

    config = SimpleNamespace(
        models=SimpleNamespace(embedding=SimpleNamespace(slug="ecapa-tdnn-voxceleb"))
    )
    assert SessionManager._spec_embedding_slug(config) == "ecapa-tdnn-voxceleb"

    assert (
        SessionManager._spec_embedding_slug(SimpleNamespace(models=SimpleNamespace(embedding=None)))
        is None
    )
    assert SessionManager._spec_embedding_slug(None) is None


def _manager_for_assembly() -> MagicMock:
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
    mgr._fallback_pipeline_ids = {}
    return mgr


def _pipeline_config() -> MagicMock:
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
    pipeline_config.diarization.max_speakers = 2
    pipeline_config.diarization.max_embeddings_per_speaker = 5
    pipeline_config.diarization.enable_segmentation_refinement = False
    return pipeline_config


async def _create(mgr: MagicMock, **overrides) -> None:
    from stt.streaming.session_manager import SessionManager

    mock_session = MagicMock()
    mock_session.force_persist = AsyncMock()

    with (
        patch("stt.streaming.session_manager.StreamSession", return_value=mock_session),
        patch("stt.streaming.session_manager.ResultPublisher"),
        patch("stt.streaming.session_manager.StreamingPreprocessor"),
        patch("stt.streaming.session_manager.StreamingInferenceWorker"),
        patch("stt.streaming.session_manager.IngestionConsumer") as mock_ic,
        patch("stt.streaming.session_manager.ControlListener") as mock_cl,
        patch("stt.diarization.speaker_tracker.SpeakerTracker"),
        patch("stt.diarization.speaker_identifier.SpeakerIdentifier"),
    ):
        mock_ic.return_value.start = AsyncMock()
        mock_cl.return_value.start = AsyncMock()

        mgr._profile = MagicMock()
        mgr._profile.denoise_enabled_default = False
        mgr._load_pipeline_config = AsyncMock(return_value=_pipeline_config())
        mgr._load_vad_service = AsyncMock(return_value=MagicMock())
        mgr._load_asr_pipeline = AsyncMock(return_value=(MagicMock(), None))
        mgr._assemble_session_runtime = lambda **kw: SessionManager._assemble_session_runtime(
            mgr, **kw
        )
        mgr._load_gloss_pipeline = AsyncMock(return_value=None)
        mgr._spec_embedding_slug = MagicMock(return_value="wespeaker-voxceleb-resnet34")
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
            **overrides,
        )


@pytest.mark.asyncio
async def test_create_session_stashes_the_pushed_profiles_and_seeds_them():
    mgr = _manager_for_assembly()

    await _create(mgr, voice_profiles=PROFILES)

    # In memory only — never persisted to Redis session metadata, exactly like the BYO
    # provider overrides beside it.
    assert mgr._session_voice_profiles["sess-1"] == PROFILES
    mgr._seed_voice_profiles.assert_called_once()
    args = mgr._seed_voice_profiles.call_args.args
    assert args[1] == "sess-1"
    assert args[2] == "wespeaker-voxceleb-resnet34"


@pytest.mark.asyncio
async def test_a_session_with_no_pushed_profiles_still_opens_and_still_seeds_nothing():
    mgr = _manager_for_assembly()

    await _create(mgr)

    assert "sess-1" not in mgr._session_voice_profiles
    # The seeding call still happens (it is the ONE place the decision is made) and the
    # helper answers "nothing to seed" — diarization then produces generic labels.
    mgr._seed_voice_profiles.assert_called_once()


@pytest.mark.asyncio
async def test_no_embedding_service_means_no_speaker_identifier_and_no_seeding():
    """TASK-887 fail-closed: the platform singleton that used to stand in here is gone, so a
    session whose agent bound no embedding model does not diarize by embedding at all."""
    mgr = _manager_for_assembly()
    mgr._get_pipeline_embedding_service = AsyncMock(return_value=None)
    mgr._spec_embedding_model_id = MagicMock(return_value=None)

    await _create(mgr, voice_profiles=PROFILES)

    mgr._seed_voice_profiles.assert_not_called()
