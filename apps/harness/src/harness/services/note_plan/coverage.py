"""Deterministic note coverage — the check the harness runs BEFORE the note is persisted.

Three checks, no model call:

* every active critical fact of the ledger is present in the note (all its anchors, and each
  value with its unit);
* every number+unit a checked section states matches a source that section cites;
* every citation label in ``sources[].refs`` resolves through ``coverage.sourceIds`` (or names a
  fact line of a ledger block the plan rendered).

No ledger (``coverage.criticalFacts`` absent) means the note was not checked: ``unchecked``.
The repair ONE call is the executor's; this module only says which sections need it.
"""

from __future__ import annotations

import re
from collections.abc import Collection, Iterable, Mapping, Sequence

from harness.services.note_plan.models import (
    CoverageCitationCounts,
    CoverageFactCounts,
    CoverageGap,
    CoverageNumberCounts,
    CoverageResultV1,
    CriticalFact,
    NotePlanV1,
)
from harness.services.note_plan.normalise import (
    canonical_number,
    canonical_unit,
    contains,
    contains_value,
    normalise_text,
)

#: The measurement units the number check recognises. A lexicon of the checker, not a setting:
#: a number with any other trailing word ("4 weeks", "2 tablets") is not checked at all, which
#: keeps the check to values a transcription slip turns into a dosing or result error.
_UNITS = (
    "mmol/l", "mg/dl", "mg/l", "ng/l", "ng/ml", "g/dl", "g/l", "u/l", "iu/l", "meq/l", "kg/m2",
    "mmhg", "mcg", "µg", "μg", "ug", "mg", "kg", "ml", "iu", "bpm", "cm", "mm", "°c", "°f",
    "g", "l", "%",
)  # fmt: skip
_UNIT_PATTERN = "|".join(re.escape(unit) for unit in sorted(_UNITS, key=len, reverse=True))
_NUMBER_UNIT = re.compile(
    rf"(?<![\w.,/])(?P<value>\d+(?:[.,]\d+)?)\s*(?P<unit>{_UNIT_PATTERN})(?![a-z0-9/])",
    re.IGNORECASE,
)

_LEAD_LABEL = re.compile(r"^\s*\[(?P<label>[SAR]\d+)(?:\s[^\]]*)?\]")
_BRACKETED_LABEL = re.compile(r"\[(?P<label>[SAR]\d+)\]")
_LEDGER_FACT_LINE = re.compile(r"^\s*(?P<fact>E\d+-F\d+)\b")

NumberKey = tuple[str, str]


def extract_numbers(text: str) -> list[NumberKey]:
    """Every ``(value, unit)`` with a recognised unit, normalised, in order, de-duplicated."""
    found = (
        (canonical_number(m.group("value")), canonical_unit(m.group("unit")))
        for m in _NUMBER_UNIT.finditer(normalise_text(text))
    )
    return list(dict.fromkeys(found))


def _source_texts(plan: NotePlanV1) -> tuple[dict[str, list[str]], set[str]]:
    """Each citation label → the rendered lines that carry it; plus the ledger fact ids."""
    texts: dict[str, list[str]] = {}
    ledger_facts: set[str] = set()
    for block in plan.blocks:
        for line in block.content.splitlines():
            labels: list[str] = []
            lead = _LEAD_LABEL.match(line)
            if lead:
                labels.append(lead.group("label"))
            labels.extend(m.group("label") for m in _BRACKETED_LABEL.finditer(line))
            fact = _LEDGER_FACT_LINE.match(line) if block.role == "encounter_ledger" else None
            if fact:
                labels.append(fact.group("fact"))
                ledger_facts.add(fact.group("fact"))
            for label in dict.fromkeys(labels):
                texts.setdefault(label, []).append(line)
    return texts, ledger_facts


def _inline_labels(text: str) -> list[str]:
    return [m.group("label") for m in _BRACKETED_LABEL.finditer(text)]


def _fact_present(fact: CriticalFact, note: str, note_numbers: set[NumberKey]) -> bool:
    if not all(contains(note, anchor) for anchor in fact.anchors if anchor.strip()):
        return False
    for number in fact.numbers:
        if number.unit:
            if (canonical_number(number.value), canonical_unit(number.unit)) not in note_numbers:
                return False
        elif not contains_value(note, number.value):
            return False
    return True


def _fact_terms(fact: CriticalFact) -> list[str]:
    terms = [anchor for anchor in fact.anchors if anchor.strip()]
    terms.extend(f"{n.value} {n.unit or ''}".strip() for n in fact.numbers)
    return terms


def _ordered(plan: NotePlanV1, keys: Iterable[str]) -> list[str]:
    wanted = set(keys)
    return [h.key for h in plan.headings if h.key in wanted]


def _gap_section(
    plan: NotePlanV1,
    fact: CriticalFact,
    checked: list[str],
    cited_by: Mapping[str, set[str]],
) -> str | None:
    if not checked:
        return None
    if fact.section_hint in checked:
        return fact.section_hint
    citations = set(fact.citations)
    for key in checked:
        if cited_by.get(key, set()) & citations:
            return key
    return checked[0]


def check_coverage(
    plan: NotePlanV1,
    sections: Mapping[str, str],
    sources: Mapping[str, Sequence[str]],
    *,
    repair_passes: int = 0,
    checked_keys: Collection[str] | None = None,
) -> CoverageResultV1:
    """The coverage of one note. ``sections`` is the WHOLE note (preserved sections included,
    so a fact a clinician already wrote counts as present); numbers and citations are checked
    only in ``checked_keys`` — the sections this run wrote (all headings by default)."""
    if plan.coverage.critical_facts is None:
        return CoverageResultV1(
            status="unchecked",
            repair_passes=repair_passes,
            gaps=[
                CoverageGap(
                    kind="ledger_unavailable",
                    detail="The fact ledger was not available, so the note was not checked.",
                )
            ],
        )

    checked = _ordered(plan, checked_keys if checked_keys is not None else sections.keys())
    texts, ledger_facts = _source_texts(plan)
    known_labels = set(plan.coverage.source_ids) | ledger_facts
    gaps: list[CoverageGap] = []

    cited_by: dict[str, set[str]] = {
        key: set(sources.get(key, ())) | set(_inline_labels(sections.get(key, "")))
        for key in checked
    }

    # Critical facts — present anywhere in the note.
    note = normalise_text("\n\n".join(sections.get(h.key, "") for h in plan.headings))
    note_numbers = set(extract_numbers(note))
    facts = plan.coverage.critical_facts
    missing: list[str] = []
    for fact in facts:
        if _fact_present(fact, note, note_numbers):
            continue
        missing.append(fact.fact_id)
        segment_ids = [
            plan.coverage.source_ids[label].id
            for label in fact.citations
            if label in plan.coverage.source_ids
        ]
        gaps.append(
            CoverageGap(
                kind="missing_fact",
                fact_id=fact.fact_id,
                section_key=_gap_section(plan, fact, checked, cited_by),
                segment_ids=segment_ids or None,
                detail=f"{fact.kind} fact is not stated in the note: {'; '.join(_fact_terms(fact))}.",
            )
        )

    # Numbers — every value+unit a checked section states, against what that section cites.
    number_total = number_matched = 0
    for key in checked:
        stated = extract_numbers(sections.get(key, ""))
        if not stated:
            continue
        labels = cited_by[key] or set(texts)
        support_text = "\n".join(line for label in labels for line in texts.get(label, ()))
        supported = set(extract_numbers(support_text))
        for fact in facts:
            if labels & (set(fact.citations) | {fact.fact_id}):
                supported.update(
                    (canonical_number(n.value), canonical_unit(n.unit)) for n in fact.numbers
                )
        for value, unit in stated:
            number_total += 1
            if (value, unit) in supported:
                number_matched += 1
                continue
            gaps.append(
                CoverageGap(
                    kind="number_mismatch",
                    section_key=key,
                    detail=(
                        f"{value} {unit} in {plan.heading_title(key)} is not supported by the "
                        "sources it cites."
                    ),
                )
            )

    # Citations — every label resolves.
    citation_total = citation_resolved = 0
    unresolved: list[str] = []
    for key in checked:
        for label in dict.fromkeys(sources.get(key, ())):
            citation_total += 1
            if label in known_labels:
                citation_resolved += 1
                continue
            if label not in unresolved:
                unresolved.append(label)
            gaps.append(
                CoverageGap(
                    kind="unresolved_citation",
                    section_key=key,
                    detail=f"Citation {label} in {plan.heading_title(key)} does not resolve.",
                )
            )

    return CoverageResultV1(
        status="gaps" if gaps else "complete",
        repair_passes=repair_passes,
        critical_facts=CoverageFactCounts(
            total=len(facts), present=len(facts) - len(missing), missing=missing
        ),
        numbers=CoverageNumberCounts(
            total=number_total,
            matched=number_matched,
            unsupported=number_total - number_matched,
        ),
        citations=CoverageCitationCounts(
            total=citation_total, resolved=citation_resolved, unresolved=unresolved
        ),
        gaps=gaps,
    )


def gap_section_keys(plan: NotePlanV1, result: CoverageResultV1) -> list[str]:
    """The sections a repair must regenerate, in template order (none when unchecked)."""
    if result.status != "gaps":
        return []
    return _ordered(plan, (g.section_key for g in result.gaps if g.section_key))


def repair_directive(
    plan: NotePlanV1, result: CoverageResultV1, section_keys: Sequence[str]
) -> str:
    """The directive of the ONE repair call: only the gap sections, and what each must fix.

    It names facts by their anchors, values and source labels — never a sentence of the note.
    """
    wanted = set(section_keys)
    titles = ", ".join(plan.heading_title(key) for key in _ordered(plan, wanted))
    facts = {fact.fact_id: fact for fact in plan.coverage.critical_facts or ()}
    lines = [f"Rewrite only these sections: {titles}."]
    for gap in result.gaps:
        if gap.section_key not in wanted:
            continue
        if gap.kind == "missing_fact" and gap.fact_id in facts:
            fact = facts[gap.fact_id]
            labels = " ".join(f"[{label}]" for label in fact.citations)
            lines.append(f"- State: {'; '.join(_fact_terms(fact))} {labels}".rstrip())
        elif gap.kind in ("number_mismatch", "unresolved_citation"):
            lines.append(f"- Fix: {gap.detail}")
    lines.append("State every listed item and cite its source label exactly as labelled.")
    return "\n".join(lines)
