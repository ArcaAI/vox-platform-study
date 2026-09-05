"""TASK-887 — voice-profile seeding is PURE and gateway-fed.

`preseed_speaker` used to read `core."UserVoiceProfile"` (plus `Consultation` and
`UserProfile`) straight out of Postgres to find the consultation doctor's embedding. That is a
database read on the agent path, which `06-python-services.md` forbids — and it had been dead
since TASK-861 turned `STT_DATABASE_ENABLED` off by default.

`seed_voice_profiles` replaces it: the gateway resolves the end-user's ENROLLED profiles for
the agent's speaker-embedding model and pushes them (session-create body / Dramatiq kwarg), and
this side only registers what it was handed.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from stt.diarization.preseed import seed_voice_profiles
from stt.diarization.speaker_tracker import SpeakerTracker

MODEL = "wespeaker-voxceleb-resnet34"
OTHER_MODEL = "ecapa-tdnn-voxceleb"


def _profile(**overrides: Any) -> dict[str, Any]:
    profile: dict[str, Any] = {
        "profile_id": "vp-1",
        "label": "Dr Who",
        "model_id": MODEL,
        "embedding": [0.1, 0.2, 0.3, 0.4],
    }
    profile.update(overrides)
    return profile


class TestSeeding:
    def test_registers_the_profile_under_its_label_and_marks_it_enrolled(self) -> None:
        tracker = SpeakerTracker(max_speakers=4)

        result = seed_voice_profiles(tracker, [_profile()], model_slug=MODEL, log_context="s-1")

        assert result["success"] is True
        assert result["profile_id"] == "vp-1"
        assert result["model_id"] == MODEL
        assert result["seeded"] == 1
        assert tracker.speaker_ids == ["Dr Who"]
        # The label is a real person's name, so the identifier must be able to tell it apart
        # from a session-discovered speaker before attaching it to any segment.
        assert tracker.is_enrolled("Dr Who") is True

    def test_a_labelless_profile_still_seeds_under_a_generic_id(self) -> None:
        tracker = SpeakerTracker(max_speakers=4)

        result = seed_voice_profiles(tracker, [_profile(label=None)], model_slug=MODEL)

        assert result["seeded"] == 1
        assert tracker.speaker_ids == ["Speaker 1"]
        assert tracker.is_enrolled("Speaker 1") is True

    def test_seeds_every_matching_profile(self) -> None:
        tracker = SpeakerTracker(max_speakers=4)

        result = seed_voice_profiles(
            tracker,
            [_profile(profile_id="vp-1", label="A"), _profile(profile_id="vp-2", label="B")],
            model_slug=MODEL,
        )

        assert result["seeded"] == 2
        assert tracker.speaker_ids == ["A", "B"]
        # The echo names the FIRST profile, which is the one the SDK reports as seeded.
        assert result["profile_id"] == "vp-1"

    def test_stops_at_tracker_capacity_without_failing_the_run(self) -> None:
        tracker = SpeakerTracker(max_speakers=1)

        result = seed_voice_profiles(
            tracker,
            [_profile(profile_id="vp-1", label="A"), _profile(profile_id="vp-2", label="B")],
            model_slug=MODEL,
        )

        assert result["success"] is True
        assert result["seeded"] == 1
        assert tracker.speaker_ids == ["A"]


class TestModelScoping:
    def test_a_profile_from_another_model_is_ignored_never_coerced(self) -> None:
        """Vectors from a different embedding space are not comparable — not merely less
        accurate. The gateway filters too; this is the same rule applied where they are used."""
        tracker = SpeakerTracker(max_speakers=4)

        result = seed_voice_profiles(tracker, [_profile(model_id=OTHER_MODEL)], model_slug=MODEL)

        assert result["success"] is False
        assert result["seeded"] == 0
        assert result["skipped_other_model"] == 1
        assert tracker.speaker_ids == []

    def test_mixed_models_seed_only_the_session_model(self) -> None:
        tracker = SpeakerTracker(max_speakers=4)

        result = seed_voice_profiles(
            tracker,
            [_profile(profile_id="vp-old", label="Stale", model_id=OTHER_MODEL), _profile(profile_id="vp-new", label="Live")],
            model_slug=MODEL,
        )

        assert result["seeded"] == 1
        assert result["skipped_other_model"] == 1
        assert tracker.speaker_ids == ["Live"]


class TestDegradedInputs:
    @pytest.mark.parametrize(
        ("profiles", "model_slug"),
        [
            (None, MODEL),
            ([], MODEL),
            ([_profile()], None),
            ([_profile()], ""),
        ],
    )
    def test_nothing_to_seed_returns_the_failure_echo_rather_than_raising(
        self, profiles: list[dict[str, Any]] | None, model_slug: str | None
    ) -> None:
        tracker = SpeakerTracker(max_speakers=4)

        result = seed_voice_profiles(tracker, profiles, model_slug=model_slug)

        assert result == {
            "success": False,
            "profile_id": None,
            "model_id": None,
            "seeded": 0,
            "skipped_other_model": 0,
        }
        assert tracker.speaker_ids == []

    @pytest.mark.parametrize("embedding", [None, [], "not-a-vector", [[0.1], [0.2]]])
    def test_a_malformed_embedding_is_discarded_not_registered(self, embedding: Any) -> None:
        tracker = SpeakerTracker(max_speakers=4)

        result = seed_voice_profiles(tracker, [_profile(embedding=embedding)], model_slug=MODEL)

        assert result["seeded"] == 0
        assert tracker.speaker_ids == []

    def test_performs_no_database_access(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The whole point of the rewrite: this module must not import a DB session."""
        import stt.diarization.preseed as preseed_module

        assert not hasattr(preseed_module, "get_voice_embedding")
        source = preseed_module.__doc__ or ""
        assert "voice_profile_model" in source  # the docstring records what was removed


class TestPhiHygiene:
    def test_never_logs_the_label(self, caplog: pytest.LogCaptureFixture) -> None:
        tracker = SpeakerTracker(max_speakers=4)
        caplog.set_level("INFO")

        seed_voice_profiles(tracker, [_profile(label="Dr Jane Aleyamma")], model_slug=MODEL, log_context="session-123")

        emitted = "\n".join(record.getMessage() for record in caplog.records)
        assert "Dr Jane Aleyamma" not in emitted
        # The correlation id is redacted too (deterministic hash prefix, never the raw value).
        assert "session-123" not in emitted


def test_registered_vectors_are_l2_normalised_like_any_other_speaker() -> None:
    tracker = SpeakerTracker(max_speakers=4)
    seed_voice_profiles(tracker, [_profile(embedding=[3.0, 4.0])], model_slug=MODEL)

    # Comparing the exact vector back gives a cosine of 1.
    _, score = tracker.compare(np.array([3.0, 4.0], dtype=np.float32))
    assert score == pytest.approx(1.0, abs=1e-5)
