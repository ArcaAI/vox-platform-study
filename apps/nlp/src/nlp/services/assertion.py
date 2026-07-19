"""TASK-518 — negation / assertion detection.

A deterministic, offline ConText/NegEx-style rule engine that labels each
recognized clinical entity with an :class:`AssertionStatus` describing the
claim its mention makes about the patient (PRESENT / ABSENT / HISTORICAL /
FAMILY / HYPOTHETICAL).

Algorithm (simplified ConText):
  1. Restrict scope to the *sentence* that contains the entity (a trigger in a
     neighbouring sentence must not leak across the boundary).
  2. Scan the sentence text *preceding* the entity for the nearest trigger
     phrase from a category lexicon (pre-triggers; the dominant clinical case
     — "no chest pain", "history of asthma", "family history of MI").
  3. Apply a fixed category precedence when several fire, then fall back to
     PRESENT.

Model-swap seam
---------------
:class:`AssertionModel` is the abstract seam. ``NegExAssertionClassifier`` is
the deterministic default. A learned model (e.g. a fine-tuned classifier over
the [entity, sentence] pair) can be dropped in by implementing the same
``classify`` contract and wiring it where the default is constructed — no
caller changes required.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from collections.abc import Iterable, Sequence

from nlp.schemas.common import AssertionStatus, Entity

# Pre-trigger lexicon, keyed by the status a match implies. Phrases are matched
# on word boundaries in the (lowercased) pre-context. Ordered longest-first per
# category at match time so "family history" wins over "history".
_TRIGGERS: dict[AssertionStatus, tuple[str, ...]] = {
    AssertionStatus.ABSENT: (
        "no evidence of",
        "no signs of",
        "no history of",
        "not been having",
        "absence of",
        "negative for",
        "free of",
        "without",
        "denies",
        "denied",
        "no",
        "not",
    ),
    AssertionStatus.FAMILY: (
        "family history of",
        "family hx of",
        "fhx",
        "mother",
        "father",
        "brother",
        "sister",
        "sibling",
        "parents",
        "maternal",
        "paternal",
        "familial",
    ),
    AssertionStatus.HYPOTHETICAL: (
        "rule out",
        "r/o",
        "return if",
        "call if",
        "come back if",
        "in case of",
        "possibility of",
        "possible",
        "concern for",
        "should there be",
        "if",
    ),
    AssertionStatus.HISTORICAL: (
        "history of",
        "hx of",
        "status post",
        "s/p",
        "previous",
        "previously",
        "prior",
        "past medical history",
        "in the past",
    ),
}

# When multiple categories match in the pre-context, the first in this order
# wins. ABSENT dominates (a negated finding is absent regardless of tense);
# FAMILY beats HISTORICAL so "family history of ..." is FAMILY, not HISTORICAL.
_PRECEDENCE: tuple[AssertionStatus, ...] = (
    AssertionStatus.ABSENT,
    AssertionStatus.FAMILY,
    AssertionStatus.HYPOTHETICAL,
    AssertionStatus.HISTORICAL,
)


class AssertionModel(ABC):
    """Model-swap seam for assertion detection (rule engine or learned model)."""

    @abstractmethod
    def classify(self, text: str, entities: Sequence[Entity]) -> list[Entity]:
        """Assign ``entity.assertion`` for each entity, in place; return them."""
        raise NotImplementedError


class NegExAssertionClassifier(AssertionModel):
    """Deterministic ConText/NegEx-style assertion classifier (default)."""

    def __init__(self, triggers: dict[AssertionStatus, tuple[str, ...]] | None = None):
        self._triggers = triggers or _TRIGGERS
        # Pre-compile a word-boundary regex per phrase, longest-first per category.
        self._compiled: dict[AssertionStatus, list[re.Pattern[str]]] = {}
        for status, phrases in self._triggers.items():
            ordered = sorted(set(phrases), key=len, reverse=True)
            self._compiled[status] = [
                re.compile(r"(?<!\w)" + re.escape(p) + r"(?!\w)") for p in ordered
            ]

    def classify(self, text: str, entities: Sequence[Entity]) -> list[Entity]:
        result: list[Entity] = []
        for entity in entities:
            entity.assertion = self._classify_span(text or "", entity.position.start)
            result.append(entity)
        return result

    def _classify_span(self, text: str, start: int) -> AssertionStatus:
        pre = self._pre_context(text, start).lower()
        if not pre.strip():
            return AssertionStatus.PRESENT
        matched = {status for status in self._compiled if self._matches(status, pre)}
        for status in _PRECEDENCE:
            if status in matched:
                return status
        return AssertionStatus.PRESENT

    def _matches(self, status: AssertionStatus, pre: str) -> bool:
        return any(pattern.search(pre) for pattern in self._compiled[status])

    @staticmethod
    def _pre_context(text: str, start: int) -> str:
        """The sentence text preceding the entity (scope-bounded)."""
        before = text[:start]
        # Cut at the last sentence terminator so a trigger in the previous
        # sentence does not leak forward.
        boundary = max(before.rfind(ch) for ch in ".;\n")
        return before[boundary + 1 :] if boundary >= 0 else before


def classify_assertions(
    text: str,
    entities: Iterable[Entity],
    model: AssertionModel | None = None,
) -> list[Entity]:
    """Convenience wrapper: label ``entities`` in ``text`` with the given model
    (defaults to the deterministic NegEx rule engine)."""
    classifier = model or NegExAssertionClassifier()
    return classifier.classify(text, list(entities))
