"""TASK-829 C-4 — output-side checks, mandatory and independent of the input verdict.

*Input validation covers **zero** output risk.* A transcript can be entirely
benign and the derivation over it still wrong in a way that matters clinically:
an extractive task can cite a span that does not exist, and a "correction" can
change a drug, a dose, a negation or a laterality. Neither is visible to any
amount of input screening.

Independence is enforced structurally rather than by convention: nothing in
`output_checks` knows what a verdict is, so no future edit can make an output
check conditional on the input having passed.

The third row of §7 — sentence-level groundedness for generative summaries — is
deliberately NOT reimplemented here. `/guardrail/groundedness` already owns it
over the NLI selection in `apps/nlp`, and a second copy would be a second
inference stack.
"""

from __future__ import annotations

from guardrail.realtime.output_checks import (
    LEXICON_LATERALITY,
    LEXICON_NEGATION,
    LEXICON_PROTECTED_TERMS,
    check_clinical_preservation,
    check_span_provenance,
)

LEXICONS = {
    LEXICON_NEGATION: ["no", "not", "denies", "without", "negative"],
    LEXICON_LATERALITY: ["left", "right", "bilateral"],
    LEXICON_PROTECTED_TERMS: ["warfarin", "heparin", "metformin"],
}

SOURCE = "Patient denies chest pain. Started warfarin 5 mg for the left leg DVT."


def _outcomes(checks: list) -> dict[str, object]:
    return {c.name: c for c in checks}


# --- NER: span provenance ---------------------------------------------------


def test_entities_that_map_to_a_real_source_span_are_kept() -> None:
    entities = [
        {"label": "DRUG", "start": 35, "end": 43, "text": "warfarin"},
        {"label": "ANATOMY", "start": 57, "end": 61, "text": "left"},
    ]
    outcome, kept = check_span_provenance(entities, SOURCE)
    assert outcome.outcome == "pass"
    assert len(kept) == 2


def test_an_entity_whose_span_does_not_match_the_source_is_dropped() -> None:
    """A hallucinated citation is not a low-confidence one — it has no referent."""
    entities = [
        {"label": "DRUG", "start": 35, "end": 43, "text": "warfarin"},
        {"label": "DRUG", "start": 35, "end": 43, "text": "heparin"},
    ]
    outcome, kept = check_span_provenance(entities, SOURCE)
    assert outcome.outcome == "flag"
    assert [e["text"] for e in kept] == ["warfarin"]
    assert outcome.labels == ("DRUG",)


def test_an_entity_pointing_outside_the_source_is_dropped() -> None:
    entities = [{"label": "DRUG", "start": 5_000, "end": 5_008, "text": "warfarin"}]
    outcome, kept = check_span_provenance(entities, SOURCE)
    assert outcome.outcome == "flag"
    assert kept == []


def test_an_entity_with_no_offsets_at_all_is_dropped_not_trusted() -> None:
    outcome, kept = check_span_provenance([{"label": "DRUG", "text": "warfarin"}], SOURCE)
    assert outcome.outcome == "flag"
    assert kept == []


def test_the_provenance_report_names_labels_and_never_the_entity_text() -> None:
    entities = [{"label": "MRN", "start": 0, "end": 4, "text": "9999"}]
    outcome, _ = check_span_provenance(entities, SOURCE)
    assert "9999" not in repr(outcome.to_dict())


def test_a_check_over_an_empty_source_cannot_pass() -> None:
    """No source means the check could not run; 'skipped' is not 'pass'."""
    outcome, kept = check_span_provenance([{"label": "DRUG", "start": 0, "end": 3}], "")
    assert outcome.outcome in ("skipped", "undetermined")
    assert outcome.blocks is True or outcome.outcome == "skipped"


# --- Grammar/spelling: clinical-term preservation ---------------------------


def test_a_pure_style_correction_passes_every_preservation_check() -> None:
    corrected = "The patient denies chest pain. Started warfarin 5 mg for the left leg DVT."
    checks = _outcomes(check_clinical_preservation(SOURCE, corrected, lexicons=LEXICONS))
    assert all(c.outcome == "pass" for c in checks.values()), checks


def test_a_dose_change_is_a_safety_event_not_a_style_change() -> None:
    corrected = SOURCE.replace("5 mg", "50 mg")
    checks = _outcomes(check_clinical_preservation(SOURCE, corrected, lexicons=LEXICONS))
    assert checks["numeric_preservation"].outcome == "flag"
    assert checks["numeric_preservation"].blocks is True


def test_a_dropped_negation_is_a_safety_event() -> None:
    """'denies chest pain' -> 'has chest pain' is the classic transcription harm."""
    corrected = SOURCE.replace("denies", "reports")
    checks = _outcomes(check_clinical_preservation(SOURCE, corrected, lexicons=LEXICONS))
    assert checks["negation_preservation"].outcome == "flag"


def test_an_added_negation_is_equally_a_safety_event() -> None:
    corrected = SOURCE.replace("Started warfarin", "Not started warfarin")
    checks = _outcomes(check_clinical_preservation(SOURCE, corrected, lexicons=LEXICONS))
    assert checks["negation_preservation"].outcome == "flag"


def test_a_laterality_flip_is_a_safety_event() -> None:
    corrected = SOURCE.replace("left leg", "right leg")
    checks = _outcomes(check_clinical_preservation(SOURCE, corrected, lexicons=LEXICONS))
    assert checks["laterality_preservation"].outcome == "flag"


def test_a_drug_substitution_is_a_safety_event() -> None:
    corrected = SOURCE.replace("warfarin", "heparin")
    checks = _outcomes(check_clinical_preservation(SOURCE, corrected, lexicons=LEXICONS))
    assert checks["protected_term_preservation"].outcome == "flag"


def test_an_undeclared_lexicon_makes_its_check_skipped_never_passed() -> None:
    """A check that silently passes when its input is missing reads as green."""
    checks = _outcomes(check_clinical_preservation(SOURCE, SOURCE, lexicons={}))
    assert checks["negation_preservation"].outcome == "skipped"
    assert checks["laterality_preservation"].outcome == "skipped"
    assert checks["protected_term_preservation"].outcome == "skipped"
    # The numeric check is a property of the text, not a taxonomy — it still runs.
    assert checks["numeric_preservation"].outcome == "pass"


def test_the_preservation_report_carries_no_clinical_text() -> None:
    corrected = SOURCE.replace("warfarin", "heparin").replace("5 mg", "50 mg")
    checks = check_clinical_preservation(SOURCE, corrected, lexicons=LEXICONS)
    blob = repr([c.to_dict() for c in checks])
    assert "warfarin" not in blob and "heparin" not in blob
    assert "chest pain" not in blob


def test_every_preservation_check_declares_a_fail_closed_posture() -> None:
    for check in check_clinical_preservation(SOURCE, SOURCE, lexicons=LEXICONS):
        assert check.fail_mode == "closed"


# --- C-4 independence -------------------------------------------------------


def test_output_checks_cannot_be_made_conditional_on_the_input_verdict() -> None:
    """Structural: this module has no idea what a verdict is, so it cannot skip."""
    from pathlib import Path

    import guardrail.realtime.output_checks as module

    source = Path(module.__file__).read_text()
    for forbidden in ("consumption", "TranscriptSegmentVerdict", "gates_derivations"):
        assert forbidden not in source, forbidden
