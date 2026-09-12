"""TASK-887 — an ENROLLED profile's label is only attached above the agent's matchThreshold.

Diarization is a declared ASR-agent option: the agent names the speaker-embedding model AND
the confidence at which a segment may carry a real person's name
(`audioFrontEnd.diarization.matchThreshold`, which replaced the platform key
`stt.voiceProfile.minSimilarity`). Below that floor the speech is SOMEONE ELSE and must be
labelled generically — attaching a clinician's name to a patient's utterance is a PHI defect,
not a diarization inaccuracy.
"""

from __future__ import annotations

import numpy as np
import pytest

from stt.diarization.dto import SpeakerEmbedding, SpeakerIdentification
from stt.diarization.speaker_identifier import SpeakerIdentifier
from stt.diarization.speaker_tracker import SpeakerTracker
from stt.pipeline.dto import DiarizationConfig

ENROLLED = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32)


def _embedding(vec: np.ndarray) -> SpeakerEmbedding:
    return SpeakerEmbedding(embedding=vec.tolist(), segment_start=0.0, segment_end=1.0)


def _tracker_with_enrolled_label(label: str = "Dr Who", max_speakers: int = 2) -> SpeakerTracker:
    tracker = SpeakerTracker(max_speakers=max_speakers)
    tracker.register(ENROLLED, speaker_id=label, enrolled=True)
    return tracker


def _identifier(tracker: SpeakerTracker, *, match_threshold: float) -> SpeakerIdentifier:
    config = DiarizationConfig(
        enabled=True,
        high_threshold=0.7,
        low_threshold=0.4,
        match_threshold=match_threshold,
        enable_segmentation_refinement=False,
        max_speakers=tracker._max_speakers,
    )
    return SpeakerIdentifier(tracker=tracker, config=config)


def _vector_at_cosine(target: float) -> np.ndarray:
    """A unit vector whose cosine with ENROLLED is exactly `target`."""
    return np.array([target, float(np.sqrt(max(0.0, 1.0 - target**2))), 0.0, 0.0], dtype=np.float32)


class TestEnrolledLabelFloor:
    @pytest.mark.asyncio
    async def test_a_confident_match_carries_the_enrolled_label(self) -> None:
        tracker = _tracker_with_enrolled_label()
        result = await _identifier(tracker, match_threshold=0.6).identify(_embedding(ENROLLED))

        assert isinstance(result, SpeakerIdentification)
        assert result.speaker_id == "Dr Who"

    @pytest.mark.asyncio
    async def test_below_the_threshold_the_name_is_never_attached(self) -> None:
        """The ambiguous-zone fallback would otherwise hand the name out on a weak best match."""
        tracker = _tracker_with_enrolled_label()
        result = await _identifier(tracker, match_threshold=0.6).identify(
            _embedding(_vector_at_cosine(0.5))
        )

        assert isinstance(result, SpeakerIdentification)
        assert result.speaker_id != "Dr Who"
        assert result.speaker_id.startswith("Speaker")
        assert result.is_new_speaker is True

    @pytest.mark.asyncio
    async def test_at_capacity_below_the_threshold_it_says_unknown_rather_than_the_name(
        self,
    ) -> None:
        tracker = _tracker_with_enrolled_label(max_speakers=1)
        result = await _identifier(tracker, match_threshold=0.6).identify(
            _embedding(_vector_at_cosine(0.5))
        )

        assert isinstance(result, SpeakerIdentification)
        assert result.speaker_id == "unknown"

    @pytest.mark.asyncio
    async def test_the_threshold_is_the_agent_s_not_a_constant(self) -> None:
        """The SAME segment that is refused at 0.6 is accepted at 0.4 — the agent decides."""
        weak = _embedding(_vector_at_cosine(0.5))

        strict = await _identifier(_tracker_with_enrolled_label(), match_threshold=0.6).identify(
            weak
        )
        lenient = await _identifier(_tracker_with_enrolled_label(), match_threshold=0.4).identify(
            weak
        )

        assert isinstance(strict, SpeakerIdentification) and strict.speaker_id != "Dr Who"
        assert isinstance(lenient, SpeakerIdentification) and lenient.speaker_id == "Dr Who"

    @pytest.mark.asyncio
    async def test_an_anonymous_speaker_is_governed_by_the_existing_thresholds_only(self) -> None:
        """There is no name to get wrong on a session-discovered speaker, so the floor that
        protects enrolled labels must not silently re-partition ordinary diarization."""
        tracker = SpeakerTracker(max_speakers=2)
        tracker.register(ENROLLED)  # anonymous — `enrolled` defaults off
        anonymous_id = tracker.speaker_ids[0]

        # 0.5 sits in the ambiguous zone (low 0.4 .. high 0.7) and below matchThreshold 0.6;
        # the enrolled branch must not fire, so the fallback keeps the best match.
        result = await _identifier(tracker, match_threshold=0.6).identify(
            _embedding(_vector_at_cosine(0.5))
        )

        assert isinstance(result, SpeakerIdentification)
        assert result.speaker_id == anonymous_id
        assert result.is_new_speaker is False


class TestTrackerEnrolmentFlag:
    def test_only_profiles_registered_as_enrolled_are_flagged(self) -> None:
        tracker = SpeakerTracker(max_speakers=3)
        tracker.register(ENROLLED, speaker_id="Dr Who", enrolled=True)
        tracker.register(np.array([0.0, 1.0, 0.0, 0.0], dtype=np.float32))

        assert tracker.is_enrolled("Dr Who") is True
        assert tracker.is_enrolled("Speaker 2") is False
        assert tracker.is_enrolled("nobody") is False


class TestSpecMapping:
    def test_match_threshold_rides_the_spec_onto_the_diarization_config(self) -> None:
        from stt.pipeline.spec import AsrSpecDiarization

        wire = AsrSpecDiarization.model_validate(
            {"enabled": True, "backend": "embedding", "maxSpeakers": 2, "matchThreshold": 0.72}
        )
        assert wire.match_threshold == 0.72

    def test_an_absent_match_threshold_keeps_the_engine_default(self) -> None:
        from stt.pipeline.spec import AsrSpecDiarization

        wire = AsrSpecDiarization.model_validate(
            {"enabled": True, "backend": "embedding", "maxSpeakers": 2}
        )
        assert wire.match_threshold is None
        # …and the dataclass is the ONE source of that default.
        assert DiarizationConfig().match_threshold == 0.6

    def test_the_field_is_omitted_from_the_wire_when_absent_never_serialised_as_null(self) -> None:
        from stt.pipeline.spec import AsrSpecDiarization

        wire = AsrSpecDiarization.model_validate(
            {"enabled": False, "backend": "embedding", "maxSpeakers": None}
        )
        assert "matchThreshold" not in wire.model_dump(by_alias=True)

    def test_the_committed_fixture_carries_it_all_the_way_to_the_runtime_config(self) -> None:
        """End to end on the cross-language lock: the fixture's agent sets 0.6, and the
        `DiarizationConfig` the session manager consumes carries it."""
        import json
        from pathlib import Path

        from stt.pipeline.spec import ResolvedAsrSpec, pipeline_spec_from_resolved

        fixture = None
        for parent in Path(__file__).resolve().parents:
            candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
            if candidate.exists():
                fixture = json.loads(candidate.read_text(encoding="utf-8"))
                break
        assert fixture is not None, "resolved-asr-spec.fixture.json not found"

        spec = ResolvedAsrSpec.model_validate(fixture["platformDefault"]["expected"])
        assert spec.audio_front_end.diarization.match_threshold == 0.6

        pipeline_spec, _ = pipeline_spec_from_resolved(spec)
        assert pipeline_spec.diarization.match_threshold == 0.6
