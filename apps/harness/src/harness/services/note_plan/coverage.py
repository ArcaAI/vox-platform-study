"""Deterministic note coverage — the check the harness runs BEFORE the note is persisted.

Four checks, no model call:

* every active critical fact of the ledger is present in the note (one of its anchors, and each
  value with its unit);
* every number+unit a checked section states matches a source that section cites;
* every citation label in ``sources[].refs`` resolves through ``coverage.sourceIds`` (or names a
  fact line of a ledger block the plan rendered);
* every safety statement a checked section makes is grounded (``ungrounded`` gaps): an allergy's
  agent and a dosed drug are stated by the source the sentence cites (any input when it cites
  none), and a blood pressure or pulse stated as today's is the one the latest encounter states.

A citation is matched by its LABEL whatever its spelling: ``S8``, ``[S8]``, and the rendered
``[S8 E2]`` / ``[S8 E2 Doctor 00:00]`` all name ``S8``.

An anchor is the fact's key term or one of its aliases — alternatives, so one present is enough.
A multi-word term the note words differently is present when one of its distinctive words that
the cited source also states is in the note ("troponin" for "troponin blood test"); a one-word
term (a drug, an allergen) still has to be named. A follow-up is also present under the words a
note uses for one ("follow-up", "review") — its interval, when the ledger recorded one, is still
checked as a number.
When none of a fact's anchors occurs in the source lines the fact cites (the ledger described the
fact instead of quoting it: "metformin dosage change"), the check reads the SOURCE instead: the
anchor words the source does contain, every number the source states, and — when no anchor word
is in the source at all — a citation of that source in the note. A fact the note omits still
fails, because the source's own words and numbers are then missing.

No ledger (``coverage.criticalFacts`` absent) means the note was not checked: ``unchecked``.
The repair ONE call is the executor's; this module says which sections need it and what to tell it.
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
#: A bracketed citation anywhere in a line: ``[S4]``, or the rendered ``[S4 E1]`` / ``[S4 E1 …]``.
_BRACKETED_LABEL = re.compile(r"\[(?P<label>[SAR]\d+)(?:\s[^\]]*)?\]")
_LEDGER_FACT_LINE = re.compile(r"^\s*(?P<fact>E\d+-F\d+)\b")
#: The label a ``sources[].refs`` entry names, in any of its spellings.
_REF_LABEL = re.compile(r"^\[?\s*(?P<label>[SAR]\d+|E\d+-F\d+)(?![\w-])")
#: A value as the source states it (after normalisation): "1000", "0.5", "150/95".
_SOURCE_VALUE = re.compile(r"(?<![\w.,/])\d+(?:\.\d+)?(?:/\d+)?(?![\w.,/])")
#: An anchor word worth grounding: letters only, three or more of them.
_ANCHOR_WORD = re.compile(r"[a-z][a-z]{2,}")
#: Words of a multi-word term too generic to stand for it alone: "blood" is not "troponin blood
#: test", and "daily" is not "twice daily" — frequency / duration words name the unit, the
#: qualifier ("twice", "three") carries the meaning, so "TDS" (three times daily) never covers a
#: twice-daily fact. A lexicon of the checker, not a setting.
_GENERIC_TERM_WORDS = frozenset(
    {
        "blood", "test", "tests", "level", "levels", "value", "values", "check", "scan",
        "daily", "times", "time", "per", "day", "days", "week", "weeks", "weekly",
        "hour", "hours", "hourly", "month", "months", "monthly", "dose", "doses",
    }
)  # fmt: skip
#: The words a note names a fact of this kind by, whatever the ledger's term: alternatives.
_KIND_ALTERNATIVES: dict[str, tuple[str, ...]] = {
    "follow_up": ("follow", "review", "revisit", "return", "come back")
}

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


def citation_label(ref: str) -> str:
    """The source label a citation names (``[S8 E2]`` → ``S8``); an unknown shape is kept as is."""
    match = _REF_LABEL.match(ref.strip())
    return match.group("label") if match else ref.strip()


def _strip_lead_label(line: str) -> str:
    """A source line without its citation labels (the lead one carries a timestamp)."""
    lead = _LEAD_LABEL.match(line)
    return _BRACKETED_LABEL.sub(" ", line[lead.end() :] if lead else line)


def _numbers_present(
    numbers: Iterable[tuple[str, str | None]], note: str, note_numbers: set[NumberKey]
) -> bool:
    for value, unit in numbers:
        if unit:
            if (canonical_number(value), canonical_unit(unit)) not in note_numbers:
                return False
        elif not contains_value(note, value):
            return False
    return True


def _source_numbers(source: str) -> list[tuple[str, str | None]]:
    """Every value the source states — with its unit when it has one, bare otherwise."""
    with_unit = extract_numbers(source)
    bare = [(m.group(0), None) for m in _SOURCE_VALUE.finditer(normalise_text(source))]
    return [*with_unit, *bare]


def _anchor_present(
    fact: CriticalFact, note: str, note_numbers: set[NumberKey], source: str, cited: bool
) -> bool:
    """One of the fact's anchors is in the note — literally when an anchor is in its cited source,
    otherwise read off the source (its words in the anchor, its numbers, its citation)."""
    anchors = [anchor for anchor in fact.anchors if anchor.strip()]
    if not anchors:
        return True
    alternatives = _KIND_ALTERNATIVES.get(fact.kind, ())
    if any(contains(note, alternative) for alternative in alternatives):
        return True
    source_text = normalise_text(source)
    if not source_text or any(contains(source_text, anchor) for anchor in anchors):
        if any(contains(note, anchor) for anchor in anchors):
            return True
        return any(
            contains(note, word)
            for anchor in anchors
            for word in _term_words(anchor)
            if not source_text or contains(source_text, word)
        )
    grounded = [
        word
        for anchor in anchors
        for word in _ANCHOR_WORD.findall(normalise_text(anchor))
        if contains(source_text, word)
    ]
    if grounded:
        if not any(contains(note, word) for word in grounded):
            return False
    elif not cited:
        return False
    return _numbers_present(_source_numbers(source), note, note_numbers)


def _term_words(anchor: str) -> list[str]:
    """The distinctive words of a MULTI-word anchor; a one-word anchor stands only for itself."""
    words = _ANCHOR_WORD.findall(normalise_text(anchor))
    if len(words) < 2:
        return []
    return [word for word in words if word not in _GENERIC_TERM_WORDS]


def _fact_present(
    fact: CriticalFact,
    note: str,
    note_numbers: set[NumberKey],
    source: str = "",
    cited: bool = False,
) -> bool:
    if not _anchor_present(fact, note, note_numbers, source, cited):
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


#: An allergy statement and the agent it names: "allergic to X", "allergy to X", "allergies: X",
#: "X allergy" / "X-allergic". Applied to normalised text.
_ALLERGY_AGENT = (
    re.compile(
        r"\ballerg(?:ic|y|ies)\s+(?:reaction\s+)?(?:to|with)\s+(?:the\s+|a\s+|an\s+)?"
        r"(?P<agent>[a-z][a-z0-9-]{2,})"
    ),
    re.compile(r"\ballerg(?:y|ies)\s*[:–-]\s*(?P<agent>[a-z][a-z0-9-]{2,})"),
    re.compile(r"\b(?P<agent>[a-z][a-z0-9]{2,})[\s-]+allerg(?:y|ies|ic)\b"),
)
#: Words in an agent's position that name no agent ("no known drug allergies", "has allergy").
#: A lexicon of the checker, not a setting.
_NOT_AN_AGENT = frozenset(
    {
        "drug", "drugs", "food", "foods", "known", "any", "medication", "medications", "medicine",
        "medicines", "seasonal", "contact", "skin", "severe", "mild", "the", "his", "her", "their",
        "has", "had", "have", "reported", "documented", "history", "previous", "prior", "new",
        "other", "multiple", "environmental", "patient", "noted", "and", "with", "was", "not",
        "denies", "nil", "none",
    }
)  # fmt: skip
#: A drug named with its dose ("metformin 500 mg"), on normalised text. Weights ("77 kg") and
#: concentrations ("mg/dl") are not doses and are not matched.
_DOSED_DRUG = re.compile(
    r"(?<![\w-])(?P<drug>[a-z][a-z-]{3,})\s+\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu)(?![a-z0-9/])"
)
#: Words before a dose that are not a drug ("increased to 10 mg", "dose of 5 mg"). A lexicon of
#: the checker, not a setting.
_NOT_A_DRUG = frozenset(
    {
        "from", "with", "dose", "doses", "dosage", "about", "around", "total", "only", "daily",
        "then", "than", "once", "twice", "take", "takes", "taking", "took", "given", "give",
        "start", "started", "starting", "increase", "increased", "increasing", "reduce",
        "reduced", "reducing", "decrease", "decreased", "continue", "continued", "continuing",
        "stop", "stopped", "each", "every", "plus", "also", "into", "upto", "over", "under",
        "least", "most", "more", "less", "night", "morning", "evening", "bedtime", "tablet",
        "tablets", "capsule", "capsules", "injection", "units", "unit", "approximately",
        "nearly", "just", "same", "current", "currently", "dosed", "back", "down", "high",
        "low", "further", "additional", "extra", "maximum", "minimum", "usual", "regular",
    }
)  # fmt: skip
#: A vital reading as a note or a transcript states it (normalised text): blood pressure as a
#: paired value, pulse as one value.
_VITAL_READINGS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "BP",
        re.compile(
            r"(?<![a-z])(?:bp|b\.p\.?|blood pressure)(?![a-z])[^.;!?\d]{0,30}?"
            r"(?P<value>\d{2,3}/\d{2,3})(?!\d|\.\d|/)"
        ),
    ),
    (
        "pulse",
        re.compile(
            r"(?<![a-z])(?:pulse(?: rate)?|heart rate|hr|p\.r\.?)(?![a-z])[^.;!?\d]{0,20}?"
            r"(?P<value>\d{2,3})(?!\d|\.\d|/)"
        ),
    ),
)
#: A sentence that dates its reading or calls it an earlier one ("recorded 2025-06-20",
#: "previous", "baseline") is not stating today's reading.
_EARLIER_READING = re.compile(
    r"\b(?:recorded|previous(?:ly)?|prior|earlier|last visit|history|baseline|initial|"
    r"first encounter|on admission)\b|\d{4}-\d{2}-\d{2}|(?<![\d/])\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b"
)
_ANY_BRACKET = re.compile(r"\[[^\]]*\]")
_SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+|\n+")


def _sentences(text: str) -> list[str]:
    return [sentence for sentence in _SENTENCE_BREAK.split(text) if sentence.strip()]


def _readings(text: str) -> dict[str, list[str]]:
    """Every vital reading the (normalised) text states, by vital, in order."""
    found: dict[str, list[str]] = {}
    for vital, pattern in _VITAL_READINGS:
        for match in pattern.finditer(text):
            found.setdefault(vital, [])
            if match.group("value") not in found[vital]:
                found[vital].append(match.group("value"))
    return found


def _allergy_agents(text: str) -> list[str]:
    agents = (
        match.group("agent").strip("-")
        for pattern in _ALLERGY_AGENT
        for match in pattern.finditer(text)
    )
    return list(dict.fromkeys(a for a in agents if a not in _NOT_AN_AGENT))


def _dosed_drugs(text: str) -> list[str]:
    drugs = (match.group("drug").strip("-") for match in _DOSED_DRUG.finditer(text))
    return list(dict.fromkeys(d for d in drugs if d not in _NOT_A_DRUG))


def _grounding_gaps(
    plan: NotePlanV1,
    sections: Mapping[str, str],
    checked: Sequence[str],
    texts: Mapping[str, list[str]],
) -> list[CoverageGap]:
    """Safety statements a checked section makes that its sources do not support.

    * An allergy's agent, and a drug named with its dose, must be stated by a source the sentence
      cites — or, when the sentence cites no source label, by some input of the plan. A note that
      pins an earlier visit's allergy on today's "allergic to penicillin" line passes the number and
      citation checks; this is the check that catches it.
    * A blood pressure or pulse stated as today's, when the LATEST encounter's transcript states a
      different one, is an earlier reading (the clinic's open-time vitals, a previous visit) passed
      off as today's. A sentence that dates or qualifies its reading, or cites the transcript line
      that states it, is not.
    """
    corpus = normalise_text(
        "\n".join(
            [
                _strip_lead_label(line)
                for block in plan.blocks
                for line in block.content.splitlines()
            ]
            + [anchor for fact in plan.coverage.critical_facts or () for anchor in fact.anchors]
        )
    )
    spoken_labels = {
        label
        for block in plan.blocks
        if block.role in ("encounter_transcript", "encounter_ledger", "attachment_transcript")
        for line in block.content.splitlines()
        for label in [m.group("label") for m in _BRACKETED_LABEL.finditer(line)]
    }
    latest = next(
        (block for block in reversed(plan.blocks) if block.role == "encounter_transcript"), None
    )
    latest_readings = _readings(normalise_text(latest.content)) if latest else {}

    gaps: list[CoverageGap] = []
    seen: set[tuple[str, str]] = set()

    def _gap(key: str, term: str, detail: str) -> None:
        if (key, term) in seen:
            return
        seen.add((key, term))
        gaps.append(CoverageGap(kind="ungrounded", section_key=key, detail=detail))

    for key in checked:
        title = plan.heading_title(key)
        for sentence in _sentences(sections.get(key, "")):
            labels = [label for label in dict.fromkeys(_inline_labels(sentence)) if label in texts]
            body = normalise_text(_ANY_BRACKET.sub(" ", sentence))
            cited = normalise_text(
                "\n".join(_strip_lead_label(line) for label in labels for line in texts[label])
            )
            support = cited if labels else corpus
            named = ", ".join(labels)
            for agent in _allergy_agents(body):
                if contains(support, agent):
                    continue
                _gap(
                    key,
                    f"allergy:{agent}",
                    (
                        f"{title} states an allergy to {agent}, but {named} does not state it."
                        if labels
                        else f"{title} states an allergy to {agent}, which no source states."
                    ),
                )
            for drug in _dosed_drugs(body):
                if contains(support, drug):
                    continue
                _gap(
                    key,
                    f"drug:{drug}",
                    (
                        f"{title} states {drug} with a dose, but {named} does not name it."
                        if labels
                        else f"{title} states {drug} with a dose, which no source names."
                    ),
                )
            if not latest_readings or _EARLIER_READING.search(body):
                continue
            spoken = normalise_text(
                "\n".join(
                    _strip_lead_label(line)
                    for label in labels
                    if label in spoken_labels
                    for line in texts[label]
                )
            )
            for vital, values in _readings(body).items():
                today = latest_readings.get(vital)
                if not today:
                    continue
                for value in values:
                    if value in today or contains(spoken, value):
                        continue
                    _gap(
                        key,
                        f"{vital}:{value}",
                        f"{title} states {vital} {value} as today's reading, but the latest "
                        f"encounter's transcript states {vital} {', '.join(today)}.",
                    )
    return gaps


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
        key: {citation_label(ref) for ref in sources.get(key, ())}
        | set(_inline_labels(sections.get(key, "")))
        for key in checked
    }
    # Every label the note cites anywhere — preserved sections included, like the facts.
    note_cites = {citation_label(ref) for refs in sources.values() for ref in refs} | {
        label for h in plan.headings for label in _inline_labels(sections.get(h.key, ""))
    }

    # Critical facts — present anywhere in the note.
    # Citation labels are not note text: "[S4 E1]" must not read as the value 4.
    note = normalise_text(
        _BRACKETED_LABEL.sub(" ", "\n\n".join(sections.get(h.key, "") for h in plan.headings))
    )
    note_numbers = set(extract_numbers(note))
    facts = plan.coverage.critical_facts
    missing: list[str] = []
    for fact in facts:
        source = "\n".join(
            _strip_lead_label(line) for label in fact.citations for line in texts.get(label, ())
        )
        if _fact_present(fact, note, note_numbers, source, bool(note_cites & set(fact.citations))):
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
            if citation_label(label) in known_labels:
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

    gaps.extend(_grounding_gaps(plan, sections, checked, texts))

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
    plan: NotePlanV1,
    result: CoverageResultV1,
    section_keys: Sequence[str],
    drafts: Mapping[str, str] | None = None,
) -> str:
    """The directive of the ONE repair call: only the gap sections, and what each must fix.

    ``drafts`` is the text the first pass wrote for those sections. The repair EDITS it — handed
    back, kept sentence by sentence — rather than rewriting the section from a list: measured on
    the summarization model against a live two-encounter replay, a rewrite from fact terms alone
    dropped facts the section already had and rarely restored the missing one. Each missing fact
    is quoted from the source line it cites (a fact naming no rendered line falls back to its
    anchors and values).
    """
    wanted = set(section_keys)
    ordered = _ordered(plan, wanted)
    titles = ", ".join(plan.heading_title(key) for key in ordered)
    facts = {fact.fact_id: fact for fact in plan.coverage.critical_facts or ()}
    texts, _ = _source_texts(plan)
    # Blank lines dropped: the directive stays one paragraph after the shared prefix.
    previous = [
        (key, "\n".join(line for line in (drafts or {}).get(key, "").splitlines() if line.strip()))
        for key in ordered
    ]
    previous = [(key, text) for key, text in previous if text]
    lines = [f"Rewrite only these sections: {titles}."]
    if previous:
        lines.append(
            "Your previous draft of these sections is below. Keep every sentence of it, except what "
            "a Fix line asks you to correct, and add each fact listed after it that the draft left "
            "out: one sentence per fact, written in English from its quoted source line and ending "
            "with that label."
        )
        lines.append("Previous draft:")
        for key, text in previous:
            lines.extend([f"## {plan.heading_title(key)}", text])
        lines.append("Add these facts:")
    else:
        lines.append(
            "The previous draft of these sections left out the facts listed below. Write each "
            "listed fact into its section, worded from its source line, and end it with that "
            "label. Keep every other fact the section needs."
        )
    for gap in result.gaps:
        if gap.section_key not in wanted:
            continue
        if gap.kind == "missing_fact" and gap.fact_id in facts:
            fact = facts[gap.fact_id]
            kind = fact.kind.replace("_", " ")
            labels = " ".join(f"[{label}]" for label in fact.citations)
            quoted = " ".join(
                " ".join(_strip_lead_label(line).split())
                for label in fact.citations
                for line in texts.get(label, ())
            ).strip()
            if quoted:
                lines.append(f'- {kind} {labels}: "{quoted}"')
            else:
                lines.append(f"- {kind}: {'; '.join(_fact_terms(fact))} {labels}".rstrip())
        elif gap.kind in ("number_mismatch", "unresolved_citation", "ungrounded"):
            lines.append(f"- Fix: {gap.detail}")
    return "\n".join(lines)
