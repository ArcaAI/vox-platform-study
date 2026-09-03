"""negation / assertion detection.

A deterministic, offline ConText/NegEx-style rule engine that labels each
recognized clinical entity with an :class:`AssertionStatus` describing the
claim its mention makes about the patient (PRESENT / ABSENT / HISTORICAL /
FAMILY / HYPOTHETICAL).

Algorithm (simplified ConText):
  1. Restrict scope to the *sentence* that contains the entity (a trigger in a
     neighbouring sentence must not leak across the boundary).
  2. Scan the sentence text *preceding* the entity for the nearest trigger
     phrase from the CONFIGURED category lexicon (pre-triggers; the dominant
     clinical case — "no chest pain", "history of asthma", "family history of
     MI"). The lexicon is configuration, not code — see below.
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

from nlp.schemas.clinical_taxonomy import AssertionTaxonomy
from nlp.schemas.common import AssertionStatus, Entity

# THE TRIGGER LEXICON IS CONFIGURATION.
#
# It used to be `_TRIGGERS`, four Python tuples of ConText/NegEx phrases. Rule 00
# Principles names a label set / taxonomy as something that is
# never a literal in code, and a negation lexicon is exactly that: it is
# language- and site-specific (a dictation-heavy clinic negates differently from
# a typed-note one), and widening it should never require a redeploy. It now
# lives on `AiModel._metadata.clinicalTaxonomy.assertion.triggers` of the row
# `nlp.ner` selects and arrives per request.
#
# An UNCONFIGURED lexicon labels nothing: every span stays PRESENT, the schema's
# own documented default for an un-triggered mention. That is the fail-safe
# direction — this service never asserts "the patient does NOT have X" on
# evidence it invented.

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
        # NO bundled default: an absent lexicon means nothing is triggered.
        self._triggers = triggers or {}
        # Pre-compile a word-boundary regex per phrase, longest-first per category.
        self._compiled: dict[AssertionStatus, list[re.Pattern[str]]] = {}
        for status, phrases in self._triggers.items():
            ordered = sorted(set(phrases), key=len, reverse=True)
            self._compiled[status] = [
                re.compile(r"(?<!\w)" + re.escape(p) + r"(?!\w)") for p in ordered
            ]

    @classmethod
    def from_taxonomy(cls, taxonomy: AssertionTaxonomy) -> NegExAssertionClassifier:
        """Build a classifier from the gateway-injected `assertion` section.

        An unknown status key is IGNORED rather than rejected, so widening
        `AssertionStatus` later never invalidates a stored taxonomy.
        """
        by_status: dict[AssertionStatus, tuple[str, ...]] = {}
        for raw_status, phrases in taxonomy.triggers.items():
            try:
                status = AssertionStatus(raw_status)
            except ValueError:
                continue
            if phrases:
                by_status[status] = tuple(phrases)
        return cls(by_status)

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
