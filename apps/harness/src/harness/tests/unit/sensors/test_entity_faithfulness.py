"""Entity-faithfulness sensor tests (RED-first).

Heuristic under test: every entity asserted in the *note* must be grounded in
the transcript — by a transcript NER span of the same text, or by a verbatim
mention in the transcript text. Ungrounded note entities (fabrications) are
flagged. A medication in the note but not the transcript -> faithfulness fails.
"""

from __future__ import annotations

import pytest

from harness.sensors.base import SensorContext
from harness.sensors.computational.entity_faithfulness import (
    NAME,
    EntityFaithfulnessSensor,
)

from ._fixtures import ner


def _ctx(**over):
    base = {
        "transcript_text": "Patient reports hypertension. Started lisinopril 10 mg daily.",
        "transcript_entities": [ner("hypertension", "CONDITION"), ner("lisinopril", "MEDICATION")],
    }
    base.update(over)
    return SensorContext(**base)


class TestEntityFaithfulness:
    def test_medication_in_note_not_in_transcript_fails(self):
        ctx = _ctx(
            note_entities=[
                ner("hypertension", "CONDITION"),
                ner("lisinopril", "MEDICATION"),
                ner("metformin", "MEDICATION"),  # fabricated — absent from transcript
            ]
        )
        result = EntityFaithfulnessSensor().run(ctx)
        assert result.name == NAME
        assert result.passed is False
        assert result.claims_flagged == ["metformin"]
        assert result.score == pytest.approx(2 / 3)

    def test_all_note_entities_grounded_passes(self):
        ctx = _ctx(note_entities=[ner("hypertension"), ner("lisinopril")])
        result = EntityFaithfulnessSensor().run(ctx)
        assert result.passed is True
        assert result.score == pytest.approx(1.0)
        assert result.claims_flagged == []

    def test_grounding_via_transcript_text_substring(self):
        # "10 mg daily" is in the transcript text but not in the entity list.
        ctx = _ctx(transcript_entities=[], note_entities=[ner("10 mg daily")])
        result = EntityFaithfulnessSensor().run(ctx)
        assert result.passed is True
        assert result.claims_flagged == []

    def test_no_note_entities_is_vacuously_faithful(self):
        result = EntityFaithfulnessSensor().run(_ctx(note_entities=[]))
        assert result.passed is True
        assert result.score == pytest.approx(1.0)

    def test_no_transcript_at_all_is_degraded_not_pass(self):
        # Note asserts entities but there is nothing to verify against.
        ctx = SensorContext(
            note_entities=[ner("hypertension"), ner("lisinopril")],
            transcript_text="",
            transcript_entities=[],
        )
        result = EntityFaithfulnessSensor().run(ctx)
        assert result.degraded is True
        assert result.passed is False
        assert set(result.claims_flagged) == {"hypertension", "lisinopril"}

    def test_absent_note_entity_excluded_from_positive_claim_check(self):
        # an ABSENT (negated) note entity ("metformin" the patient is
        # NOT on) is not a positive claim, so it must not be required to be
        # grounded in the transcript and must not fail faithfulness.
        ctx = _ctx(
            note_entities=[
                ner("hypertension", "CONDITION"),
                ner("lisinopril", "MEDICATION"),
                ner("metformin", "MEDICATION", assertion="ABSENT"),
            ]
        )
        result = EntityFaithfulnessSensor().run(ctx)
        assert result.passed is True
        assert result.score == pytest.approx(1.0)
        assert "metformin" not in result.claims_flagged

    def test_threshold_is_configurable(self):
        # 3/4 grounded == 0.75; passes at 0.7, fails at the zero-tolerance default.
        ctx = _ctx(
            note_entities=[ner("hypertension"), ner("lisinopril"), ner("aspirin", "MEDICATION")],
            transcript_text="hypertension lisinopril aspirin",
            transcript_entities=[],
        )
        # all three grounded -> 1.0 regardless of threshold
        assert EntityFaithfulnessSensor(threshold=0.7).run(ctx).passed is True
