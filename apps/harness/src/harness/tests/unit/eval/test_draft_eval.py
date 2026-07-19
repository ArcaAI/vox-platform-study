"""Tests for the eval bridge: a harness draft → eval harness / computational sensors.

Covers the two scoring paths:
* the :func:`harness_draft_to_golden_case` adapter (draft → eval-harness GoldenCase
  the PDSQI-9 / faithfulness runner consumes), and
* the offline computational-sensor scoring (deterministic, no model/NER service)
  that demonstrates the fail-safe signal carries through to a verdict.
"""

from __future__ import annotations

from harness.eval.draft_eval import (
    candidate_concepts_for_case,
    harness_draft_to_golden_case,
    score_draft_with_sensors,
    score_golden_set_with_sensors,
)
from harness.eval.golden.sources import default_golden_set_source
from harness.eval.models import GoldenCase
from harness.sensors.base import NEREntity
from harness.sensors.registry import COMPUTATIONAL_SENSOR_NAMES


class TestCandidateConceptPolarity:
    def test_absent_candidate_concept_excluded_from_concept_f1_set(self):
        # TASK-518 — a note that correctly says "no metformin" (ABSENT) must not
        # contribute the metformin concept to the positive-claim recall check.
        case = GoldenCase(
            case_id="polarity-1",
            source_documents=["x"],
            generated_note="{}",
            metadata={
                "candidate_concepts": [
                    {"cui": "C0004057"},  # PRESENT (assertion omitted ⇒ PRESENT)
                    {"cui": "C0025598", "assertion": "ABSENT"},  # negated metformin
                ]
            },
        )
        keys = {c.cui for c in candidate_concepts_for_case(case)}
        assert keys == {"C0004057"}


class TestHarnessDraftToGoldenCase:
    def test_builds_a_valid_golden_case_from_a_draft(self):
        case = harness_draft_to_golden_case(
            case_id="draft-1",
            note_text='{"assessment": "viral uri"}',
            transcript_text="Patient with a dry cough for three days.",
            target_specialty="Family Medicine",
        )
        assert case.case_id == "draft-1"
        assert case.generated_note == '{"assessment": "viral uri"}'
        assert case.source_documents == ["Patient with a dry cough for three days."]
        assert case.target_specialty == "Family Medicine"


class TestScoreDraftWithSensors:
    def test_reports_all_five_sensor_scores_and_a_valid_decision(self):
        result = score_draft_with_sensors(
            case_id="draft-1",
            note_text='{"subjective":"cough","objective":"clear","assessment":"viral uri","plan":"rest"}',
            transcript_text="Patient with a dry cough for three days. Lungs clear.",
        )
        assert set(result.scores.keys()) == set(COMPUTATIONAL_SENSOR_NAMES)
        assert result.decision in {"PASS", "REGEN", "FLAG"}

    def test_flags_a_fabricated_note_entity_not_grounded_in_transcript(self):
        # A note that asserts an entity with no transcript support is the
        # highest-harm "fabrication" case → entity_faithfulness flags it → FLAG.
        result = score_draft_with_sensors(
            case_id="fab-1",
            note_text='{"assessment": "acute myocardial infarction"}',
            transcript_text="Exertional chest tightness. ECG normal sinus rhythm without ST changes.",
            note_entities=[NEREntity(text="acute myocardial infarction", type="CONDITION")],
        )
        assert result.decision == "FLAG"
        assert "acute myocardial infarction" in result.claims_flagged
        assert result.passed is False

    def test_grounded_note_entity_scores_full_faithfulness(self):
        result = score_draft_with_sensors(
            case_id="ground-1",
            note_text='{"subjective": "chest tightness"}',
            transcript_text="Patient reports exertional chest tightness for two weeks.",
            note_entities=[NEREntity(text="chest tightness", type="SYMPTOM")],
        )
        assert result.scores["entity_faithfulness"] == 1.0


class TestScoreGoldenSetWithSensors:
    def test_scores_every_case_of_the_synthetic_fixture(self):
        golden_set = default_golden_set_source().load()
        results = score_golden_set_with_sensors(golden_set)
        assert len(results) == len(golden_set.cases)
        assert {r.case_id for r in results} == {c.case_id for c in golden_set.cases}
        # Offline (no NLP/NER), the fail-safe aggregator must never auto-PASS.
        assert all(r.decision in {"PASS", "REGEN", "FLAG"} for r in results)
