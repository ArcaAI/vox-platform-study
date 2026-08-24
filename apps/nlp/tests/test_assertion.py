"""negation / assertion detection (ConText/NegEx-style).

RED-first: written before ``nlp.services.assertion`` exists. The classifier
assigns each recognized clinical entity an *assertion status* describing the
claim its mention makes about the patient:

  * PRESENT      — asserted about the patient now ("patient has chest pain")
  * ABSENT       — negated ("no chest pain", "denies fever")
  * HISTORICAL   — in the patient's past ("history of asthma")
  * FAMILY       — about a relative, not the patient ("family history of MI")
  * HYPOTHETICAL — conditional / non-actual ("if symptoms worsen", "rule out PE")

It is a deterministic, offline rule engine over a trigger lexicon (no model
download, no network) with a documented seam to swap in a learned model.

TASK-799 lane G: the lexicon is CONFIGURATION and arrives per request on the
gateway-resolved `clinicalTaxonomy.assertion.triggers`, so these cases build the
classifier from the seeded platform baseline. The behaviour they pin is
unchanged; where the phrases come from is not.
"""

from __future__ import annotations

import uuid

from nlp.schemas.common import AssertionStatus, Entity, TextPosition
from nlp.services.assertion import NegExAssertionClassifier
from tests.clinical_taxonomy_fixture import seeded_taxonomy


def _entity(text: str, full: str) -> Entity:
    start = full.index(text)
    return Entity(
        id=str(uuid.uuid4()),
        text=text,
        normalized_text=text.strip().lower(),
        entity_type="CONDITION",
        confidence=0.99,
        position=TextPosition(start=start, end=start + len(text)),
    )


def _classify(full: str, span: str) -> AssertionStatus:
    clf = NegExAssertionClassifier.from_taxonomy(seeded_taxonomy().assertion)
    [entity] = clf.classify(full, [_entity(span, full)])
    return entity.assertion


def test_negation_marks_absent():
    assert _classify("Patient reports no chest pain today.", "chest pain") == AssertionStatus.ABSENT


def test_denies_marks_absent():
    assert _classify("She denies fever or chills.", "fever") == AssertionStatus.ABSENT


def test_family_history_marks_family():
    # FAMILY must win over HISTORICAL even though "history of" also matches.
    assert _classify("Family history of MI in the father.", "MI") == AssertionStatus.FAMILY


def test_conditional_marks_hypothetical():
    assert (
        _classify("Return if symptoms worsen or SOB develops.", "SOB")
        == AssertionStatus.HYPOTHETICAL
    )


def test_rule_out_marks_hypothetical():
    assert (
        _classify("Plan: rule out pulmonary embolism.", "pulmonary embolism")
        == AssertionStatus.HYPOTHETICAL
    )


def test_history_of_marks_historical():
    assert _classify("History of asthma since childhood.", "asthma") == AssertionStatus.HISTORICAL


def test_plain_mention_is_present():
    assert (
        _classify("Patient has chest pain radiating to the arm.", "chest pain")
        == AssertionStatus.PRESENT
    )


def test_default_present_field_on_entity():
    # An Entity constructed without going through the classifier still has a
    # well-defined default assertion (PRESENT) so every downstream write is safe.
    e = _entity("cough", "productive cough")
    assert e.assertion == AssertionStatus.PRESENT


def test_scope_does_not_leak_across_sentence_boundary():
    # The negation in the first sentence must NOT flip the entity in the second.
    full = "No fever. Patient has chest pain."
    assert _classify(full, "chest pain") == AssertionStatus.PRESENT


def test_classify_is_idempotent_and_batch():
    clf = NegExAssertionClassifier.from_taxonomy(seeded_taxonomy().assertion)
    full = "No chest pain. History of asthma."
    entities = [_entity("chest pain", full), _entity("asthma", full)]
    out = clf.classify(full, entities)
    assert [e.assertion for e in out] == [AssertionStatus.ABSENT, AssertionStatus.HISTORICAL]
