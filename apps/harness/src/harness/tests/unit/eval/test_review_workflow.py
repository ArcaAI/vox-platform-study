"""The clinician review workflow: render the artifact, apply amendments, ship a version.

This is the path by which a doctor's judgement becomes the authoritative reference
rating. The tests lock the two properties that make it trustworthy: an amendment cannot
be anonymous, and applying one never mutates the set a historical run was scored against.
"""

from __future__ import annotations

import json

import pytest

from harness.eval.golden.review.apply_amendments import AmendmentError, apply_amendments
from harness.eval.golden.review.render_review import render
from harness.eval.golden.sources import FIXTURES_DIR

CURATED_V2 = FIXTURES_DIR / "curated_v2.json"


@pytest.fixture(scope="module")
def golden() -> dict:
    return json.loads(CURATED_V2.read_text(encoding="utf-8"))


def _amendments(**over) -> dict:
    base = {
        "reviewer": "Dr A. Example",
        "reviewed_at": "2026-09-01",
        "amendments": [
            {
                "case_id": "cv2-s01-L2-fabrication",
                "ratings": {"accurate": 1},
                "note": "reads as 1 to me",
            }
        ],
    }
    base.update(over)
    return base


def test_render_covers_every_case_and_states_the_provenance(golden) -> None:
    md = render(golden)
    for case in golden["cases"]:
        assert f"### `{case['case_id']}`" in md
    assert "None of these are clinician" in md
    assert "PENDING CLINICIAN REVIEW" in md
    # The reviewer must be able to see the note, the defect and the rationale.
    assert "**Note under review**" in md
    assert "**Seeded defect(s)**" in md
    assert "**Rationale (the rule that produced it)**" in md
    assert "**Reviewer decision**" in md


def test_amendment_applies_only_the_named_dimensions(golden) -> None:
    out = apply_amendments(golden, _amendments(), version="curated-v2.1.0")

    before = next(c for c in golden["cases"] if c["case_id"] == "cv2-s01-L2-fabrication")
    after = next(c for c in out["cases"] if c["case_id"] == "cv2-s01-L2-fabrication")
    assert after["clinician_pdsqi"]["accurate"] == 1
    for dim, value in before["clinician_pdsqi"].items():
        if dim != "accurate":
            assert after["clinician_pdsqi"][dim] == value


def test_amendment_marks_provenance_and_attribution(golden) -> None:
    out = apply_amendments(golden, _amendments(), version="curated-v2.1.0")
    amended = next(c for c in out["cases"] if c["case_id"] == "cv2-s01-L2-fabrication")
    meta = amended["metadata"]
    assert meta["clinician_review_status"] == "reviewed"
    assert meta["label_provenance"] == "clinician-reviewed"
    assert meta["clinician_reviewer"] == "Dr A. Example"
    assert meta["clinician_reviewed_at"] == "2026-09-01"
    assert meta["clinician_amended_dimensions"] == ["accurate"]

    # Unlisted cases stay PENDING unless the reviewer says they read the whole set.
    other = next(c for c in out["cases"] if c["case_id"] == "cv2-s02-L5-gold")
    assert other["metadata"]["clinician_review_status"] == "pending"
    assert other["metadata"]["label_provenance"] == "ai-authored-rubric-literal"


def test_accept_all_unlisted_marks_the_whole_set_reviewed(golden) -> None:
    out = apply_amendments(golden, _amendments(accept_all_unlisted=True), version="curated-v2.1.0")
    statuses = {c["metadata"]["clinician_review_status"] for c in out["cases"]}
    assert statuses == {"reviewed"}


def test_new_version_is_shipped_and_the_input_is_untouched(golden) -> None:
    original = json.loads(CURATED_V2.read_text(encoding="utf-8"))
    out = apply_amendments(golden, _amendments(), version="curated-v2.1.0")
    assert out["version"] == "curated-v2.1.0"
    assert golden == original, "apply_amendments must not mutate its input document"
    assert json.loads(CURATED_V2.read_text(encoding="utf-8")) == original


def test_an_unattributed_amendment_is_refused(golden) -> None:
    for missing in ("reviewer", "reviewed_at"):
        bad = _amendments(**{missing: ""})
        with pytest.raises(AmendmentError, match="reviewer"):
            apply_amendments(golden, bad, version="curated-v2.1.0")


def test_unknown_case_or_dimension_is_refused(golden) -> None:
    with pytest.raises(AmendmentError, match="absent from the golden set"):
        apply_amendments(
            golden,
            _amendments(amendments=[{"case_id": "does-not-exist", "ratings": {"accurate": 1}}]),
            version="curated-v2.1.0",
        )
    with pytest.raises(AmendmentError, match="unknown PDSQI dimension"):
        apply_amendments(
            golden,
            _amendments(
                amendments=[{"case_id": "cv2-s01-L5-gold", "ratings": {"bedside_manner": 1}}]
            ),
            version="curated-v2.1.0",
        )


def test_amended_document_is_still_a_valid_golden_set(golden) -> None:
    """An out-of-range rating must be caught here, not at the next gate run."""
    with pytest.raises(Exception, match="Likert|validation"):
        apply_amendments(
            golden,
            _amendments(amendments=[{"case_id": "cv2-s01-L5-gold", "ratings": {"accurate": 9}}]),
            version="curated-v2.1.0",
        )


def test_shipped_amendments_template_is_empty_and_inert() -> None:
    template = json.loads(
        (FIXTURES_DIR.parent / "review" / "curated_v2_amendments.json").read_text(encoding="utf-8")
    )
    assert template["amendments"] == []
    assert template["reviewer"] == ""
    assert template["accept_all_unlisted"] is False
