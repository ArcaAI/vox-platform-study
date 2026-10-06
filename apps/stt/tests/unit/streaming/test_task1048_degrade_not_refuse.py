"""TASK-1048 Lane D — optional stages degrade, they never fail a session, and every
degradation reaches the client as a ``status: degraded`` frame (once per reason).

Reasons are the frozen vocabulary ``ASR_RUNTIME_DEGRADED_REASONS``
(``packages/types/src/asr-degradation.ts``).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt.pipeline.dto import LexiconConfig, PostprocessingConfig
from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance
from stt.streaming.redis_streams import ResultPublisher
from tests.helpers.resolved_spec import resolved_spec

PROFILES = [
    {
        "profile_id": "vp-1",
        "label": "Dr Who",
        "model_id": "wespeaker-voxceleb-resnet34",
        "embedding": [0.1, 0.2],
    }
]


def _frames(redis: AsyncMock) -> list[dict[str, str]]:
    return [c.args[1] for c in redis.xadd.call_args_list]


# --------------------------------------------------------------------------- publisher


class TestPublishDegradedOnce:
    @pytest.mark.asyncio
    async def test_publishes_each_reason_once_per_session(self) -> None:
        redis = AsyncMock()
        pub = ResultPublisher(redis=redis, session_id="s1")

        await pub.publish_degraded_once("vad_unavailable")
        await pub.publish_degraded_once("vad_unavailable")
        await pub.publish_degraded_once("gloss_unavailable")

        frames = _frames(redis)
        assert [f["reason"] for f in frames] == ["vad_unavailable", "gloss_unavailable"]
        assert all(f["status"] == "degraded" for f in frames)

    @pytest.mark.asyncio
    async def test_a_redis_failure_never_raises(self) -> None:
        redis = AsyncMock()
        redis.xadd.side_effect = ConnectionError("redis down")
        pub = ResultPublisher(redis=redis, session_id="s1")

        await pub.publish_degraded_once("lexicon_unavailable")  # must not raise


# --------------------------------------------------------------------------- worker


def _utterance(*, is_final: bool = True) -> AudioUtterance:
    return AudioUtterance(
        samples=np.random.randn(16000).astype(np.float32),
        sample_rate=16000,
        start_time=0.0,
        end_time=1.0,
        utterance_index=0,
        is_final=is_final,
    )


class _BoomCorrector:
    def correct(self, text: str):
        raise RuntimeError("lexicon exploded")


class TestLexiconGuard:
    @pytest.mark.asyncio
    async def test_a_raising_corrector_emits_raw_text_and_publishes_once(self) -> None:
        redis = AsyncMock()
        worker = StreamingInferenceWorker(
            result_publisher=ResultPublisher(redis=redis, session_id="s1"),
            asr_pipeline=lambda samples, sr: "treated with septrioxone",
            postprocessing_config=PostprocessingConfig(
                lexicon=LexiconConfig(enabled=True, terms=["ceftriaxone"])
            ),
        )
        worker._lexicon_corrector = _BoomCorrector()
        worker._partial_lexicon_corrector = _BoomCorrector()

        first = await worker.process_utterance("s1", _utterance())
        second = await worker.process_partial("s1", _utterance(is_final=False))

        assert first.text == "treated with septrioxone"
        assert second.text == "treated with septrioxone"
        reasons = [f["reason"] for f in _frames(redis) if f.get("status") == "degraded"]
        assert reasons == ["lexicon_unavailable"]


class TestSpeakerIdentificationDegrade:
    @pytest.mark.asyncio
    async def test_identify_raising_returns_none_and_publishes_once(self) -> None:
        redis = AsyncMock()
        identifier = MagicMock()
        identifier.identify = AsyncMock(side_effect=RuntimeError("no model"))
        worker = StreamingInferenceWorker(
            result_publisher=ResultPublisher(redis=redis, session_id="s1"),
            tenant_id="t1",
            diarization_config=MagicMock(enabled=True),
            speaker_identifier=identifier,
        )

        for _ in range(2):
            sid, conf = await worker._identify_speaker(MagicMock(), "hello world")
            assert (sid, conf) == (None, None)

        reasons = [f["reason"] for f in _frames(redis)]
        assert reasons == ["diarization_unavailable"]


# --------------------------------------------------------------------------- assembly


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
    mgr._session_voice_profile_seeded = {}
    mgr._fallback_pipeline_ids = {}
    mgr._session_specs = {}
    mgr._session_language_modes = {}
    mgr._register_resolved_spec = lambda *a, **k: SessionManager._register_resolved_spec(
        mgr, *a, **k
    )
    mgr._creating = set()
    mgr._empty_decode_streaks = {}
    return mgr


def _pipeline_config(*, vad: bool = True, diarization: bool = True, seg: bool = False) -> MagicMock:
    pc = MagicMock()
    pc.preprocessing.vad.enabled = vad
    pc.preprocessing.vad.threshold = 0.5
    pc.preprocessing.vad.min_speech_duration_ms = 250
    pc.preprocessing.vad.min_silence_duration_ms = 700
    pc.preprocessing.denoise.enabled = False
    pc.preprocessing.normalize = False
    pc.preprocessing.target_sample_rate = 16000
    pc.diarization.enabled = diarization
    pc.diarization.backend = "embedding"
    pc.diarization.max_speakers = 2
    pc.diarization.max_embeddings_per_speaker = 5
    pc.diarization.enable_segmentation_refinement = seg
    return pc


async def _create(mgr: MagicMock, pipeline_config: MagicMock, **kw) -> MagicMock:
    """Run create_session; return the (mock) ResultPublisher instance."""
    from stt.streaming.session_manager import SessionManager

    mock_session = MagicMock()
    mock_session.force_persist = AsyncMock()
    publisher = MagicMock()
    publisher.publish_degraded_once = AsyncMock()
    publisher.publish_denoise_degraded = AsyncMock()

    with (
        patch("stt.streaming.session_manager.StreamSession", return_value=mock_session),
        patch("stt.streaming.session_manager.ResultPublisher", return_value=publisher),
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
        mgr._load_pipeline_config = AsyncMock(return_value=pipeline_config)
        mgr._load_vad_service = kw.pop("load_vad", AsyncMock(return_value=MagicMock()))
        mgr._load_asr_pipeline = AsyncMock(return_value=(MagicMock(), None))
        mgr._assemble_session_runtime = lambda **k: SessionManager._assemble_session_runtime(
            mgr, **k
        )
        mgr._load_gloss_pipeline = kw.pop("load_gloss", AsyncMock(return_value=None))
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
            resolved_spec=resolved_spec(primary="p1", fallback=None),
            consultation_id="cons-1",
            sample_rate=16000,
            user_id="user-1",
            **kw,
        )
    return publisher


def _reasons(publisher: MagicMock) -> list[str]:
    return [c.args[0] if c.args else c.kwargs["reason"]
            for c in publisher.publish_degraded_once.call_args_list]


class TestAssemblyDegrades:
    @pytest.mark.asyncio
    async def test_voice_profile_seeding_raising_does_not_fail_the_session(self) -> None:
        mgr = _manager_for_assembly()
        mgr._seed_voice_profiles = MagicMock(side_effect=RuntimeError("bad profile blob"))

        publisher = await _create(mgr, _pipeline_config(), voice_profiles=PROFILES)

        assert "voice_profiles_unavailable" in _reasons(publisher)
        assert mgr._session_voice_profile_seeded["sess-1"] is False

    @pytest.mark.asyncio
    async def test_zero_profiles_is_not_a_degradation(self) -> None:
        mgr = _manager_for_assembly()
        mgr._seed_voice_profiles = MagicMock(return_value={"seeded": 0})

        publisher = await _create(mgr, _pipeline_config())

        assert _reasons(publisher) == []

    @pytest.mark.asyncio
    async def test_embedding_model_load_failure_publishes_diarization_unavailable(self) -> None:
        mgr = _manager_for_assembly()
        mgr._spec_embedding_model_id = MagicMock(return_value="some/model")
        mgr._get_pipeline_embedding_service = AsyncMock(side_effect=RuntimeError("no weights"))

        publisher = await _create(mgr, _pipeline_config())

        assert _reasons(publisher) == ["diarization_unavailable"]

    @pytest.mark.asyncio
    async def test_vad_enabled_but_not_loaded_publishes_vad_unavailable(self) -> None:
        mgr = _manager_for_assembly()
        publisher = await _create(
            mgr,
            _pipeline_config(diarization=False),
            load_vad=AsyncMock(return_value=None),
        )
        assert _reasons(publisher) == ["vad_unavailable"]

    @pytest.mark.asyncio
    async def test_vad_disabled_emits_nothing(self) -> None:
        mgr = _manager_for_assembly()
        publisher = await _create(
            mgr,
            _pipeline_config(vad=False, diarization=False),
            load_vad=AsyncMock(return_value=None),
        )
        assert _reasons(publisher) == []

    @pytest.mark.asyncio
    async def test_gloss_enabled_but_not_built_publishes_gloss_unavailable(self) -> None:
        mgr = _manager_for_assembly()
        pc = _pipeline_config(diarization=False)
        pc.inference.streaming_english_gloss = True
        publisher = await _create(mgr, pc)
        assert _reasons(publisher) == ["gloss_unavailable"]

    @pytest.mark.asyncio
    async def test_gloss_disabled_emits_nothing(self) -> None:
        mgr = _manager_for_assembly()
        pc = _pipeline_config(diarization=False)
        pc.inference.streaming_english_gloss = False
        publisher = await _create(mgr, pc)
        assert _reasons(publisher) == []

    @pytest.mark.asyncio
    async def test_segmentation_load_failure_publishes_segmentation_unavailable(self) -> None:
        mgr = _manager_for_assembly()
        mgr._spec_embedding_model_id = MagicMock(return_value="some/model")
        mgr._get_pipeline_embedding_service = AsyncMock(return_value=MagicMock())
        mgr._seed_voice_profiles = MagicMock(return_value={"seeded": 0})
        pc = _pipeline_config(seg=True)
        pc.models.segmentation.is_inline = True
        pc.models.segmentation.inline.hf_model_id = "pyannote/segmentation"

        with patch(
            "stt.diarization.segmentation_service.SegmentationService",
            side_effect=RuntimeError("no seg weights"),
        ):
            publisher = await _create(mgr, pc)

        assert _reasons(publisher) == ["segmentation_unavailable"]
