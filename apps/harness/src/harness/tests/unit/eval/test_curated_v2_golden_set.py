"""Contract tests for the `curated-v2.0.0` golden set.

These lock the DESIGN of the reference set, not the judge's behaviour: the quality
gradient, the seeded-error taxonomy, the stratification, the held-out split, the
labelling rules, and the provenance/PHI posture. All offline — no LLM, no DB.

They exist because the set is the thing the release gate trusts. A silent edit that
flattens the gradient, drops the provenance marker, or lets a case claim to be a
clinician rating would quietly re-create the `curated-v1.0.0` failure mode.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

import pytest

from harness.eval.golden.sources import FIXTURES_DIR, JSONFileGoldenSetSource
from harness.eval.models import PDSQI_LIKERT_DIMENSIONS

CURATED_V2 = FIXTURES_DIR / "curated_v2.json"

SEEDED_ERROR_TAXONOMY = {
    "omission_material",
    "omission_potentially_pertinent",
    "fabrication",
    "dose_error",
    "laterality_error",
    "temporal_error",
    "misattribution",
    "false_negation",
    "verbosity",
    "uncited_assertion",
    "under_synthesis",
}

#: The seven CLINICAL error classes the golden set must exercise at least three times
#: each, so a judge failure on any of them is attributable rather than anecdotal.
CORE_ERROR_CLASSES = {
    "omission_material",
    "fabrication",
    "dose_error",
    "laterality_error",
    "temporal_error",
    "misattribution",
    "false_negation",
}


@pytest.fixture(scope="module")
def raw() -> dict:
    return json.loads(CURATED_V2.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def golden():
    return JSONFileGoldenSetSource(CURATED_V2).load()


def test_loads_and_is_versioned(golden) -> None:
    assert golden.version == "curated-v2.0.0"
    assert len(golden.cases) == 36


def test_lane_split_matches_the_gate_contract(golden) -> None:
    """Quality lane = L5 gold notes ONLY; the gate must never grade sabotaged input."""
    roles = Counter(c.role for c in golden.cases)
    assert roles == {"quality": 12, "calibration": 24}
    for case in golden.cases:
        level = case.metadata["level"]
        assert (case.role == "quality") == (level == "L5"), case.case_id


def test_designed_quality_gradient_spans_the_scale(golden) -> None:
    """The reference ratings themselves must span 1-5 — the v1 failure was a flat lane."""
    values = [v for c in golden.cases for v in c.clinician_pdsqi.likert_items().values()]
    assert len(values) == 288, "n of paired ratings changed; update curated_v2_spec.md section 6"
    assert set(values) == {1, 2, 3, 4, 5}, "every score point must be exercised"
    # Between-case spread is the numerator of ICC. v1's quality lane had SD 0.000.
    per_case_means = [c.clinician_pdsqi.mean_quality() for c in golden.cases]
    assert max(per_case_means) - min(per_case_means) >= 3.0

    levels = Counter(c.metadata["level"] for c in golden.cases)
    assert levels == {"L5": 12, "L2": 9, "L3": 6, "L4": 5, "L1": 4}

    by_level: dict[str, list[float]] = {}
    for case in golden.cases:
        by_level.setdefault(case.metadata["level"], []).append(case.clinician_pdsqi.mean_quality())
    means = {lvl: sum(v) / len(v) for lvl, v in by_level.items()}

    # The levels encode CLINICAL severity, so the CLINICAL chain is what must be
    # monotone. L4 is deliberately NOT in this chain: it is the presentation-only band
    # (verbosity, partial citation, under-synthesis), and PDSQI docks `succinct` to 2
    # for redundancy — a heavy arithmetic penalty for a clinically harmless note. Its
    # mean therefore sits below L3's while its clinical severity is lower, which is a
    # property of the instrument, not a defect in the gradient. See
    # curated_v2_spec.md section 2.
    assert means["L5"] > means["L3"] > means["L2"] > means["L1"], means
    assert means["L5"] > means["L4"] > means["L1"], means


def test_L4_is_the_presentation_only_band(golden) -> None:
    """L4 must be clinically clean — that is what separates it from L3/L2."""
    presentation_only = {
        "verbosity",
        "uncited_assertion",
        "under_synthesis",
        "omission_potentially_pertinent",
    }
    l4 = [c for c in golden.cases if c.metadata["level"] == "L4"]
    assert l4
    for case in l4:
        classes = {e["class"] for e in case.metadata["seeded_errors"]}
        assert classes <= presentation_only, f"{case.case_id}: {classes} is a clinical defect"
        assert case.clinician_pdsqi.accurate == 5, case.case_id
        assert case.clinician_pdsqi.thorough >= 4, case.case_id


def test_quality_lane_clears_the_release_bars_by_reference(golden) -> None:
    """A reference set whose own gold notes fail the gate would be unusable."""
    quality = [c for c in golden.cases if c.role == "quality"]
    mean = sum(c.clinician_pdsqi.mean_quality() for c in quality) / len(quality)
    assert mean >= 4.0
    for dim in ("accurate", "thorough"):
        avg = sum(c.clinician_pdsqi.likert_items()[dim] for c in quality) / len(quality)
        assert avg >= 4.0, dim


def test_every_anchor_score_point_has_an_exemplar(golden) -> None:
    """Each level must be reachable by name, so a reviewer can anchor on a real case."""
    for level in ("L1", "L2", "L3", "L4", "L5"):
        assert any(c.metadata["level"] == level for c in golden.cases), level


def test_seeded_error_taxonomy_is_closed_and_covered(golden) -> None:
    counts: Counter[str] = Counter()
    for case in golden.cases:
        seeded = case.metadata.get("seeded_errors", [])
        assert isinstance(seeded, list)
        if case.role == "quality":
            assert seeded == [], f"{case.case_id}: a gold note must carry no seeded error"
        else:
            assert seeded, f"{case.case_id}: a calibration case must declare its defect"
        for err in seeded:
            assert set(err) == {"class", "span", "why_wrong"}, err
            assert err["class"] in SEEDED_ERROR_TAXONOMY, err["class"]
            assert err["span"].strip() and err["why_wrong"].strip()
            counts[err["class"]] += 1

    for cls in CORE_ERROR_CLASSES:
        assert counts[cls] >= 3, f"{cls} appears {counts[cls]}x; need >= 3 to attribute a failure"


def test_single_class_attribution_below_L1(golden) -> None:
    """L2-L4 carry exactly ONE defect, so a judge miss is attributable to that class."""
    for case in golden.cases:
        if case.metadata["level"] in ("L2", "L3", "L4"):
            assert len(case.metadata["seeded_errors"]) == 1, case.case_id
        if case.metadata["level"] == "L1":
            assert len(case.metadata["seeded_errors"]) >= 3, case.case_id


def test_stratification_is_documented_and_balanced(golden) -> None:
    assert len({c.target_specialty for c in golden.cases}) == 12
    assert Counter(c.metadata["consultation_length"] for c in golden.cases) == {
        "medium": 15,
        "short": 12,
        "long": 9,
    }
    assert Counter(c.metadata["complexity"] for c in golden.cases) == {
        "moderate": 15,
        "low": 12,
        "high": 9,
    }


def test_holdout_split_is_stratified(golden) -> None:
    splits = Counter(c.metadata["split"] for c in golden.cases)
    assert splits == {"dev": 24, "holdout": 12}
    holdout = [c for c in golden.cases if c.metadata["split"] == "holdout"]
    # The holdout must not be all one lane or all one level, or it validates nothing.
    assert len({c.role for c in holdout}) == 2
    assert len({c.metadata["level"] for c in holdout}) >= 4


def test_provenance_never_claims_a_clinician_rating(golden, raw) -> None:
    for case in golden.cases:
        assert case.metadata["label_provenance"] == "ai-authored-rubric-literal", case.case_id
        assert case.metadata["clinician_review_status"] == "pending", case.case_id
        assert case.metadata["label_rationale"].strip(), case.case_id
    description = raw["description"]
    assert "AI-GENERATED" in description
    assert "NOT A CLINICIAN RATING" in description.upper()
    assert "PENDING CLINICIAN REVIEW" in description.upper()


def test_labelling_rule_R3_content_errors_do_not_move_citation(golden) -> None:
    """Rule R3 (curated_v2_spec.md section 3): `citation` grades PAIRING, not truth.

    Locked as a test because it is the single highest-impact labelling decision in the
    set (8 cases, 3 points on one dimension) and the one flagged for clinician review.
    If a clinician reverses it, this test is what forces the reversal to be uniform.
    """
    content_classes = {
        "fabrication",
        "dose_error",
        "laterality_error",
        "temporal_error",
        "misattribution",
        "false_negation",
    }
    for case in golden.cases:
        classes = {e["class"] for e in case.metadata.get("seeded_errors", [])}
        citation_defect = classes & {"uncited_assertion"}
        if classes and classes <= content_classes and not citation_defect:
            if case.metadata["level"] == "L1":
                continue  # L1 notes are genuinely uncited as well
            assert case.clinician_pdsqi.citation == 5, (
                f"{case.case_id}: a pure content error must not lower `citation` (rule R3)"
            )


def test_labelling_rule_R4_thorough_moves_only_for_omissions(golden) -> None:
    for case in golden.cases:
        classes = {e["class"] for e in case.metadata.get("seeded_errors", [])}
        if case.metadata["level"] in ("L2", "L3", "L4") and not (
            classes & {"omission_material", "omission_potentially_pertinent"}
        ):
            assert case.clinician_pdsqi.thorough == 5, (
                f"{case.case_id}: a non-omission defect must not lower `thorough` (rule R4)"
            )


def test_labelling_rule_R6_presentation_dimensions_stay_clean(golden) -> None:
    """An accuracy defect must not bleed into organized/comprehensible/succinct."""
    accuracy_only = {"fabrication", "dose_error", "laterality_error", "false_negation"}
    for case in golden.cases:
        classes = {e["class"] for e in case.metadata.get("seeded_errors", [])}
        if case.metadata["level"] == "L2" and classes and classes <= accuracy_only:
            score = case.clinician_pdsqi
            assert (score.organized, score.comprehensible, score.succinct) == (5, 5, 5), case.case_id


def test_phi_free_by_construction(golden) -> None:
    """Synthetic identifiers only; no dates, no emails, no phone numbers, no MRN-like ids."""
    banned = [
        (re.compile(r"\b\d{4}-\d{2}-\d{2}\b"), "ISO date"),
        (re.compile(r"\b\d{1,2}/\d{1,2}/\d{2,4}\b"), "slashed date"),
        (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "email"),
        (re.compile(r"\b(?:\+?\d[\d ()-]{8,})\b"), "phone-like number"),
        (re.compile(r"\bMRN[: ]", re.I), "MRN label"),
    ]
    for case in golden.cases:
        text = " ".join([*case.source_documents, case.generated_note])
        for pattern, label in banned:
            assert not pattern.search(text), f"{case.case_id}: {label} found"
        for doc in case.source_documents:
            for token in re.findall(r"\bSYN-\d{4}\b", doc):
                assert token.startswith("SYN-"), token


def test_every_case_carries_a_full_reference_rating(golden) -> None:
    for case in golden.cases:
        assert case.clinician_pdsqi is not None, case.case_id
        items = case.clinician_pdsqi.likert_items()
        assert set(items) == set(PDSQI_LIKERT_DIMENSIONS), case.case_id


def test_review_artifact_and_spec_ship_with_the_set() -> None:
    root = Path(FIXTURES_DIR).parent
    assert (root / "curated_v2_spec.md").is_file()
    assert (root / "review" / "curated_v2_review.md").is_file()
    assert (root / "review" / "curated_v2_amendments.json").is_file()


def test_v1_is_retained_unmutated() -> None:
    """A new version SHIPS; it never overwrites the set historical runs were scored on."""
    v1 = json.loads((FIXTURES_DIR / "curated_v1.json").read_text(encoding="utf-8"))
    assert v1["version"] == "curated-v1.0.0"
    assert len(v1["cases"]) == 18
