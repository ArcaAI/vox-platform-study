"""Eval-run wiring for the TASK-482 E3 metrics (AC-4 / AC-5).

RED-first. ``draft_eval`` surfaces concept-F1 + harm-weighted-error-rate onto
``EvalCaseResult`` / ``EvalRunResult``, skip-clean when a golden reference (or, for
concept-F1, the note's candidate codes) is absent — no metric fabricates a value.
The packaged synthetic golden case deliberately omits a reference medication so
concept-F1 recall is non-degenerate (< 1.0); with the candidate codes stripped
(the pre-476 reality) the concept-F1 pass skips clean while harm-weight still runs.
"""

from __future__ import annotations

import pytest

from harness.eval.draft_eval import (
    aggregate_e3_metrics,
    concept_f1_for_case,
    eval_case_e3_metrics,
    harm_weighted_for_case,
    score_golden_set_e3,
)
from harness.eval.golden.sources import FIXTURES_DIR, JSONFileGoldenSetSource
from harness.eval.metrics.harm_weighted import MAJOR_WEIGHT, MINOR_WEIGHT
from harness.eval.models import EvalCaseResult, EvalRunResult, GoldenCase, NoteError

CONCEPT_HARM_FIXTURE = FIXTURES_DIR / "concept_harm_v0.json"


def _fixture_case() -> GoldenCase:
    golden_set = JSONFileGoldenSetSource(CONCEPT_HARM_FIXTURE).load()
    return golden_set.cases[0]


def _bare_case(**overrides) -> GoldenCase:
    base = {
        "case_id": "wiring-1",
        "source_documents": ["transcript"],
        "generated_note": "note",
    }
    base.update(overrides)
    return GoldenCase(**base)


class TestPerCaseWiring:
    def test_fixture_case_scores_non_degenerate_concept_f1(self):
        # The note omits metformin (C0025598) → recall 3/4, one missed concept.
        result = eval_case_e3_metrics(_fixture_case())
        assert isinstance(result, EvalCaseResult)
        assert result.concept_f1 is not None
        assert result.concept_f1.recall == pytest.approx(3 / 4)
        assert result.concept_f1.recall < 1.0
        assert result.concept_f1.missed_cuis == ["cui:C0025598"]

    def test_fixture_case_scores_harm_weighted_rate(self):
        # One major (medication) + one minor (narrative) over 8 weightable units.
        result = eval_case_e3_metrics(_fixture_case())
        assert result.harm_weighted_error_rate == pytest.approx((MAJOR_WEIGHT + MINOR_WEIGHT) / 8)

    def test_augments_an_existing_case_result_in_place(self):
        base = EvalCaseResult(case_id="synthetic-e3-001-omitted-med", faithfulness=None)
        result = eval_case_e3_metrics(_fixture_case(), base=base)
        # E3 fields set; the case_id (and any prior metrics) preserved.
        assert result.case_id == "synthetic-e3-001-omitted-med"
        assert result.concept_f1 is not None
        assert result.harm_weighted_error_rate is not None


class TestSkipClean:
    def test_concept_f1_skips_when_no_reference(self):
        assert concept_f1_for_case(_bare_case()) is None

    def test_harm_weight_skips_when_no_errors(self):
        assert harm_weighted_for_case(_bare_case()) is None

    def test_concept_f1_skips_when_candidate_codes_absent_pre_476(self):
        # Reference present, but the note carries NO candidate codes (metadata has
        # no candidate_concepts) — the pre-476 reality. concept-F1 skips clean;
        # harm-weight is independent of codes and still runs.
        case = _bare_case(
            reference_concepts=["C0020538", "C0025598"],
            reference_errors=[NoteError(category="medication")],
            harm_weightable_units=4,
        )
        result = eval_case_e3_metrics(case)
        assert result.concept_f1 is None  # skip clean (no candidate codes)
        assert result.harm_weighted_error_rate == pytest.approx(MAJOR_WEIGHT / 4)


class TestRunWiringSerialization:
    def test_run_result_serializes_the_new_fields(self):
        golden_set = JSONFileGoldenSetSource(CONCEPT_HARM_FIXTURE).load()
        run = score_golden_set_e3(golden_set)
        assert isinstance(run, EvalRunResult)

        dumped = run.model_dump()
        case0 = dumped["case_results"][0]
        assert "concept_f1" in case0
        assert case0["concept_f1"]["recall"] == pytest.approx(3 / 4)
        assert case0["harm_weighted_error_rate"] == pytest.approx((MAJOR_WEIGHT + MINOR_WEIGHT) / 8)
        # Round-trips back through the model.
        assert EvalRunResult.model_validate(dumped).case_results[0].concept_f1 is not None

    def test_run_aggregates_expose_e3_means(self):
        golden_set = JSONFileGoldenSetSource(CONCEPT_HARM_FIXTURE).load()
        run = score_golden_set_e3(golden_set)
        assert run.aggregates["concept_recall_mean"] == pytest.approx(3 / 4)
        assert "concept_f1_mean" in run.aggregates
        assert "harm_weighted_error_rate_mean" in run.aggregates

    def test_aggregate_ignores_skipped_cases(self):
        # A case that skips both metrics contributes nothing to the aggregates.
        skipped = eval_case_e3_metrics(_bare_case())
        assert aggregate_e3_metrics([skipped]) == {}
