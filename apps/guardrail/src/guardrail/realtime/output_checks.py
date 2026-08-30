"""C-4 — the checks that only exist on the way OUT.

Input validation covers **zero** output risk, and layered input + output is the
OWASP-aligned minimum. The two checks here are the deterministic half of §7's
table; the generative half (sentence-level groundedness for summaries) already
exists as ``/guardrail/groundedness`` over the NLI selection in ``apps/nlp`` and
is deliberately not duplicated — a second copy would be a second inference stack.

**Extractive tasks: span provenance.** Every entity must map to a character
offset that really contains it in the source. An entity that does not is not a
low-confidence entity, it is one with no referent, and it is dropped rather than
scored. This is cheap, exact, and catches the failure mode a confidence
threshold cannot.

**Transformative tasks: clinical-term preservation.** A grammar or spelling pass
is licensed to change style. It is not licensed to change a drug, a dose, a
negation or a laterality — *"denies chest pain"* becoming *"reports chest pain"*
is a safety event wearing a style change's clothes.

**Where the line between code and configuration falls.** The numeric check is
code: whether a number changed is a property of the text, true for every tenant,
in the same way that a U+E0000 character is a property of Unicode in
``injection_defense``. The negation, laterality and protected-term lexicons are
a *taxonomy* — language-specific, formulary-specific, tenant-editable — so they
arrive as configuration. An undeclared lexicon makes its check ``skipped``, never
``pass``: a check that silently passes when its input is missing is worse than no
check at all, because a dashboard reads it as green.

**PHI posture:** every outcome carries names, labels and counts. Never a matched
term, never a span of the note.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Mapping, Sequence
from typing import Any, Final

from guardrail.services.screening import (
    FAIL_CLOSED,
    OUTCOME_FLAG,
    OUTCOME_PASS,
    OUTCOME_SKIPPED,
    CheckOutcome,
)

LEXICON_NEGATION: Final = "negation"
LEXICON_LATERALITY: Final = "laterality"
LEXICON_PROTECTED_TERMS: Final = "protectedTerms"

#: Any run of digits with optional decimal part. A dose, a frequency, a duration
#: and a measurement are all numbers, and all four are unsafe to "correct".
_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
_WORD = re.compile(r"[a-z']+")


# ---------------------------------------------------------------------------
# Extractive output — span provenance
# ---------------------------------------------------------------------------


def check_span_provenance(
    entities: Sequence[Mapping[str, Any]], source_text: str
) -> tuple[CheckOutcome, list[Mapping[str, Any]]]:
    """Keep only entities that really occur at the offsets they claim.

    Returns the outcome and the SURVIVING entities. Dropping is the remedy, not
    flagging-and-forwarding: an unmappable entity has no provenance, and a
    clinician cannot verify what has no source.
    """
    name = "span_provenance"
    if not (source_text or "").strip():
        # No source ⇒ nothing to verify against. Not a pass.
        return (
            CheckOutcome(
                name=name,
                outcome=OUTCOME_SKIPPED,
                fail_mode=FAIL_CLOSED,
                reason="no_source_text",
            ),
            [],
        )

    kept: list[Mapping[str, Any]] = []
    dropped: list[str] = []
    length = len(source_text)
    for entity in entities:
        label = str(entity.get("label") or "UNKNOWN")
        start, end = entity.get("start"), entity.get("end")
        if not isinstance(start, int) or not isinstance(end, int) or isinstance(start, bool):
            dropped.append(label)
            continue
        if not (0 <= start < end <= length):
            dropped.append(label)
            continue
        claimed = entity.get("text")
        if isinstance(claimed, str) and claimed and source_text[start:end] != claimed:
            dropped.append(label)
            continue
        kept.append(entity)

    return (
        CheckOutcome(
            name=name,
            outcome=OUTCOME_FLAG if dropped else OUTCOME_PASS,
            fail_mode=FAIL_CLOSED,
            reason="unmappable_entities_dropped" if dropped else "",
            # Labels, never the entity text: this is an audit record.
            labels=tuple(sorted(set(dropped))),
        ),
        kept,
    )


# ---------------------------------------------------------------------------
# Transformative output — clinical-term preservation
# ---------------------------------------------------------------------------


def _numbers(text: str) -> Counter[str]:
    return Counter(m.group(0).replace(",", "") for m in _NUMBER.finditer(text or ""))


def _lexical(text: str, vocabulary: frozenset[str]) -> Counter[str]:
    return Counter(w for w in _WORD.findall((text or "").casefold()) if w in vocabulary)


def _diff_outcome(name: str, before: Counter[str], after: Counter[str]) -> CheckOutcome:
    """Flag when the multiset changed, reporting HOW MANY, never WHICH values."""
    if before == after:
        return CheckOutcome(name=name, outcome=OUTCOME_PASS, fail_mode=FAIL_CLOSED)
    removed = sum((before - after).values())
    added = sum((after - before).values())
    return CheckOutcome(
        name=name,
        outcome=OUTCOME_FLAG,
        fail_mode=FAIL_CLOSED,
        reason="clinical_content_altered",
        labels=(f"removed:{removed}", f"added:{added}"),
    )


def check_clinical_preservation(
    original: str, corrected: str, *, lexicons: Mapping[str, Sequence[str]] | None = None
) -> list[CheckOutcome]:
    """Four checks over a transformative edit. Every one of them fail-closed."""
    declared = lexicons or {}
    checks = [_diff_outcome("numeric_preservation", _numbers(original), _numbers(corrected))]

    for key, check_name in (
        (LEXICON_NEGATION, "negation_preservation"),
        (LEXICON_LATERALITY, "laterality_preservation"),
        (LEXICON_PROTECTED_TERMS, "protected_term_preservation"),
    ):
        terms = declared.get(key)
        if not terms:
            checks.append(
                CheckOutcome(
                    name=check_name,
                    outcome=OUTCOME_SKIPPED,
                    fail_mode=FAIL_CLOSED,
                    reason=f"no_{key}_lexicon_declared",
                )
            )
            continue
        vocabulary = frozenset(str(t).casefold() for t in terms)
        checks.append(
            _diff_outcome(
                check_name, _lexical(original, vocabulary), _lexical(corrected, vocabulary)
            )
        )
    return checks
