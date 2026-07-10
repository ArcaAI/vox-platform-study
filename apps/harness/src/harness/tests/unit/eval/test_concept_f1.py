"""MEDCON/UMLS concept-F1 tests (TASK-482 E3, AC-1 / AC-5).

RED-first. Concept-F1 scores the generated note's coded entities (candidate CUIs,
populated by TASK-476) against a golden reference concept set. Recall is the
omission catcher: dropping a reference medication CUI from the candidate set must
lower recall below 1.0. Matching is keyed on the canonical UMLS CUI with a
documented code-system fallback (snomed → rxnorm → icd → loinc) when a CUI is
absent. Pure, offline, deterministic — no services, no model.

Skip-clean is load-bearing: on the pre-476 tree every candidate code is ``None``,
so the scorer must return ``None`` (skip) rather than a false 1.0/0.0.
"""

from __future__ import annotations

import pytest

from harness.eval.metrics.concept_f1 import compute_concept_f1, score_concept_f1
from harness.eval.models import ConceptCode, ConceptF1Result


class TestConceptF1Recall:
    def test_recall_drops_when_a_reference_medication_cui_is_missing(self):
        # Candidate note codes aspirin + hypertension but DROPS metformin (a
        # medication the reference expects) → the omission catcher fires.
        candidate = [ConceptCode(cui="C0004057"), ConceptCode(cui="C0020538")]
        reference = ["C0004057", "C0020538", "C0025598"]  # C0025598 = metformin (dropped)

        result = compute_concept_f1(candidate, reference)
        assert isinstance(result, ConceptF1Result)
        assert result.recall == pytest.approx(2 / 3)
        assert result.recall < 1.0
        assert result.precision == pytest.approx(1.0)
        assert result.matched == 2
        assert result.missed_cuis == ["cui:C0025598"]
        assert result.spurious_cuis == []

    def test_perfect_overlap_scores_one(self):
        candidate = [ConceptCode(cui="C0004057"), ConceptCode(cui="C0020538")]
        reference = ["C0004057", "C0020538"]
        result = compute_concept_f1(candidate, reference)
        assert result.recall == pytest.approx(1.0)
        assert result.precision == pytest.approx(1.0)
        assert result.f1 == pytest.approx(1.0)

    def test_spurious_candidate_lowers_precision(self):
        candidate = [ConceptCode(cui="C0004057"), ConceptCode(cui="C9999999")]
        reference = ["C0004057"]
        result = compute_concept_f1(candidate, reference)
        assert result.precision == pytest.approx(1 / 2)
        assert result.recall == pytest.approx(1.0)
        assert result.spurious_cuis == ["cui:C9999999"]


class TestCodeSystemFallback:
    def test_snomed_fallback_matches_when_cui_absent(self):
        # No CUI on either side → fall back to the SNOMED code and match on it.
        candidate = [ConceptCode(snomed="38341003")]  # hypertension
        reference = ["snomed:38341003"]
        result = compute_concept_f1(candidate, reference)
        assert result.recall == pytest.approx(1.0)
        assert result.matched == 1

    def test_cui_preferred_over_lower_systems(self):
        # A candidate carrying BOTH a CUI and a SNOMED code keys on the CUI.
        candidate = [ConceptCode(cui="C0020538", snomed="38341003")]
        assert score_concept_f1(candidate, ["C0020538"]).recall == pytest.approx(1.0)
        # Same concept referenced only by its SNOMED code does NOT match the
        # CUI-keyed candidate (the canonical key is the CUI).
        assert score_concept_f1(candidate, ["snomed:38341003"]).recall == pytest.approx(0.0)

    def test_rxnorm_icd_loinc_fallback_order(self):
        assert compute_concept_f1([ConceptCode(rxnorm="29046")], ["rxnorm:29046"]).recall == 1.0
        assert compute_concept_f1([ConceptCode(icd="I10")], ["icd:I10"]).recall == 1.0
        assert compute_concept_f1([ConceptCode(loinc="4548-4")], ["loinc:4548-4"]).recall == 1.0


class TestSkipClean:
    def test_skips_clean_when_candidate_codes_all_null(self):
        # The pre-476 reality: the linker has not run, so every candidate carries
        # no code. The scorer must SKIP (None), not report a false 0.0 recall.
        candidate = [ConceptCode(), ConceptCode()]
        reference = ["C0004057", "C0020538"]
        assert score_concept_f1(candidate, reference) is None

    def test_skips_clean_when_candidate_list_empty(self):
        assert score_concept_f1([], ["C0004057"]) is None

    def test_skips_clean_when_reference_empty(self):
        assert score_concept_f1([ConceptCode(cui="C0004057")], []) is None

    def test_does_not_skip_when_candidate_has_codes(self):
        # A partially-coded candidate (some concepts dropped) is a REAL measurement,
        # not a skip — recall < 1.0 is the signal we want.
        result = score_concept_f1([ConceptCode(cui="C0004057")], ["C0004057", "C0020538"])
        assert result is not None
        assert result.recall == pytest.approx(1 / 2)
