"""Note-completeness metrics over ONE generated note of a multi-encounter golden case.

Four numbers, all deterministic (no judge model):

* **critical-fact recall** — every critical fact of the case's reference (medication + dose,
  allergy, diagnosis, plan/order, follow-up, red flag, and negations) is stated in the note;
* **dose accuracy** — every medication fact's CURRENT dose (number + unit) is stated in a sentence
  naming the drug, and the section it belongs to never states only a superseded dose;
* **unsupported-statement rate** — numbers+units the note states that its cited sources do not
  carry, plus citations that resolve to nothing, over all such statements;
* **stop→note latency** — recorded per case, aggregated as p95.

Presence, the number check and the citation check are the harness coverage check itself
(:func:`harness.services.note_plan.coverage.check_coverage`) run with the GOLDEN facts in place of
the ledger's, so the eval and the pre-persist check can never disagree about what "stated" means.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from harness.services.note_plan.coverage import check_coverage, extract_numbers
from harness.services.note_plan.merge import split_sections
from harness.services.note_plan.models import CoverageNumber, CriticalFact, NotePlanV1

GOLDEN_CASE_SHAPE = "multi_encounter_v1"

#: Fact kinds whose numbers are doses.
DOSE_KINDS = frozenset({"medication", "dose_change"})
NEGATION_KIND = "negation"

#: The cue words a negated finding must sit beside. A lexicon of the checker, like the unit list
#: of the coverage check — not a setting.
_NEGATION_CUE = re.compile(
    r"\b(no|not|denies|denied|denying|without|negative|absent|nil|none|never)\b", re.IGNORECASE
)
_SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+|\n+")


class _Wire(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="ignore", frozen=True
    )


class GoldenFact(_Wire):
    fact_id: str
    encounter_seq: int
    key: str
    kind: str
    anchors: list[str] = Field(min_length=1)
    numbers: list[CoverageNumber] = Field(default_factory=list)
    citations: list[str] = Field(default_factory=list)
    section_hint: str | None = None
    #: Doses a later encounter replaced: stating ONLY one of these where the fact belongs is a
    #: wrong dose.
    superseded_numbers: list[CoverageNumber] = Field(default_factory=list)


class GoldenReference(_Wire):
    """The ``referenceNote`` envelope of a ``multi_encounter_v1`` golden case."""

    case_shape: Literal["multi_encounter_v1"]
    reference_note: str
    critical_facts: list[GoldenFact] = Field(min_length=1)


class CaseScore(BaseModel):
    """One case's counts. Ids and numbers only — never note text."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    case_id: str
    status: Literal["scored", "error"] = "scored"
    #: Exception TYPE only (no message: a message can carry clinical text).
    error: str | None = None
    critical_facts_total: int = 0
    critical_facts_present: int = 0
    missing_fact_ids: list[str] = Field(default_factory=list)
    doses_total: int = 0
    doses_correct: int = 0
    wrong_dose_fact_ids: list[str] = Field(default_factory=list)
    statements_total: int = 0
    statements_unsupported: int = 0
    latency_ms: float | None = None
    budget_strategy: str | None = None
    call_count: int | None = None
    reduced_encounters: list[int] = Field(default_factory=list)
    reduced_facts_total: int = 0
    reduced_facts_present: int = 0

    @property
    def critical_fact_recall(self) -> float:
        return _ratio(self.critical_facts_present, self.critical_facts_total)

    @property
    def dose_accuracy(self) -> float:
        return _ratio(self.doses_correct, self.doses_total)

    @property
    def unsupported_rate(self) -> float:
        if self.statements_total == 0:
            return 0.0
        return self.statements_unsupported / self.statements_total


def _ratio(numerator: int, denominator: int) -> float:
    return 1.0 if denominator == 0 else numerator / denominator


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def note_sentences(text: str) -> list[str]:
    """The note split into sentences (a decimal point is never a break)."""
    return [_norm(part) for part in _SENTENCE_BREAK.split(text) if part.strip()]


def _number_keys(numbers: Sequence[CoverageNumber]) -> set[tuple[str, str]]:
    keys: set[tuple[str, str]] = set()
    for number in numbers:
        if number.unit:
            keys.update(extract_numbers(f"{number.value} {number.unit}"))
    return keys


def negation_stated(fact: GoldenFact, note: str) -> bool:
    """A negated finding is stated only when a sentence names it beside a negation cue."""
    anchors = [_norm(a) for a in fact.anchors if a.strip()]
    return any(
        all(anchor in sentence for anchor in anchors) and _NEGATION_CUE.search(sentence)
        for sentence in note_sentences(note)
    )


def is_dose_fact(fact: GoldenFact) -> bool:
    return fact.kind in DOSE_KINDS and any(n.unit for n in fact.numbers)


def dose_correct(fact: GoldenFact, sections: Mapping[str, str]) -> bool:
    """The current dose is stated beside the drug, and the fact's own section never states only a
    superseded dose for it."""
    drug = _norm(fact.anchors[0])
    current = _number_keys(fact.numbers)
    stale = _number_keys(fact.superseded_numbers)
    note = "\n\n".join(sections.values())
    if not any(
        drug in sentence and current <= set(extract_numbers(sentence))
        for sentence in note_sentences(note)
    ):
        return False
    home = sections.get(fact.section_hint) if fact.section_hint else None
    if stale and home:
        for sentence in note_sentences(home):
            if drug not in sentence:
                continue
            stated = set(extract_numbers(sentence))
            if stated & stale and not current <= stated:
                return False
    return True


def note_sections(plan: NotePlanV1, case_note: str) -> dict[str, str]:
    """The headed note split into ``{sectionKey: body}`` over every heading of the plan."""
    return split_sections(case_note, plan, [h.key for h in plan.headings])


def sources_by_section(sources: Sequence[Mapping[str, Any]] | None) -> dict[str, list[str]]:
    """``[{sectionKey, refs|ids}]`` → ``{sectionKey: [labels]}`` (both spellings, as the merge reads)."""
    out: dict[str, list[str]] = {}
    for entry in sources or ():
        key = entry.get("sectionKey")
        refs = entry.get("refs", entry.get("ids"))
        if isinstance(key, str) and isinstance(refs, list):
            out.setdefault(key, []).extend(r for r in refs if isinstance(r, str) and r)
    return out


def score_case(
    *,
    case_id: str,
    reference: GoldenReference,
    plan: NotePlanV1,
    case_note: str,
    sources: Sequence[Mapping[str, Any]] | None,
    latency_ms: float | None,
) -> CaseScore:
    """Score one generated note against its golden reference."""
    sections = note_sections(plan, case_note)
    refs = sources_by_section(sources)
    note = "\n\n".join(sections.values())

    stated_facts = [f for f in reference.critical_facts if f.kind != NEGATION_KIND]
    golden_plan = plan.model_copy(
        update={
            "coverage": plan.coverage.model_copy(
                update={
                    "critical_facts": [
                        CriticalFact(
                            fact_id=f.fact_id,
                            encounter_seq=f.encounter_seq,
                            key=f.key,
                            kind=f.kind,
                            anchors=f.anchors,
                            numbers=f.numbers,
                            citations=f.citations,
                            section_hint=f.section_hint,
                        )
                        for f in stated_facts
                    ]
                }
            )
        }
    )
    coverage = check_coverage(golden_plan, sections, refs)
    missing = set(coverage.critical_facts.missing)
    missing.update(
        f.fact_id
        for f in reference.critical_facts
        if f.kind == NEGATION_KIND and not negation_stated(f, note)
    )
    missing_ids = [f.fact_id for f in reference.critical_facts if f.fact_id in missing]

    dose_facts = [f for f in reference.critical_facts if is_dose_fact(f)]
    wrong = [f.fact_id for f in dose_facts if not dose_correct(f, sections)]

    reduced = sorted(r.encounter_seq for r in plan.budget.reductions)
    reduced_facts = [f for f in reference.critical_facts if f.encounter_seq in reduced]

    unresolved = coverage.citations.total - coverage.citations.resolved
    return CaseScore(
        case_id=case_id,
        critical_facts_total=len(reference.critical_facts),
        critical_facts_present=len(reference.critical_facts) - len(missing_ids),
        missing_fact_ids=missing_ids,
        doses_total=len(dose_facts),
        doses_correct=len(dose_facts) - len(wrong),
        wrong_dose_fact_ids=wrong,
        statements_total=coverage.numbers.total + coverage.citations.total,
        statements_unsupported=coverage.numbers.unsupported + unresolved,
        latency_ms=latency_ms,
        budget_strategy=plan.budget.strategy,
        call_count=len(plan.calls),
        reduced_encounters=reduced,
        reduced_facts_total=len(reduced_facts),
        reduced_facts_present=sum(1 for f in reduced_facts if f.fact_id not in missing),
    )


def failed_case(
    *, case_id: str, reference: GoldenReference, plan: NotePlanV1, error: BaseException
) -> CaseScore:
    """A case whose note could not be produced: every fact counts as missing, every dose wrong."""
    dose_facts = [f for f in reference.critical_facts if is_dose_fact(f)]
    reduced = sorted(r.encounter_seq for r in plan.budget.reductions)
    return CaseScore(
        case_id=case_id,
        status="error",
        error=type(error).__name__,
        critical_facts_total=len(reference.critical_facts),
        missing_fact_ids=[f.fact_id for f in reference.critical_facts],
        doses_total=len(dose_facts),
        wrong_dose_fact_ids=[f.fact_id for f in dose_facts],
        budget_strategy=plan.budget.strategy,
        call_count=len(plan.calls),
        reduced_encounters=reduced,
        reduced_facts_total=sum(1 for f in reference.critical_facts if f.encounter_seq in reduced),
    )


def p95(values: Sequence[float]) -> float | None:
    """Nearest-rank 95th percentile; ``None`` for no values."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)]


def aggregate(scores: Sequence[CaseScore]) -> dict[str, float]:
    """Pooled (micro) rates over every case — one missing fact anywhere moves recall below 1."""
    facts_total = sum(s.critical_facts_total for s in scores)
    doses_total = sum(s.doses_total for s in scores)
    statements_total = sum(s.statements_total for s in scores)
    reduced_total = sum(s.reduced_facts_total for s in scores)
    out: dict[str, float] = {
        "cases": float(len(scores)),
        "case_errors": float(sum(1 for s in scores if s.status == "error")),
        "critical_fact_recall": _ratio(sum(s.critical_facts_present for s in scores), facts_total),
        "dose_accuracy": _ratio(sum(s.doses_correct for s in scores), doses_total),
        "unsupported_rate": (
            sum(s.statements_unsupported for s in scores) / statements_total
            if statements_total
            else 0.0
        ),
        "reduced_encounter_fact_recall": _ratio(
            sum(s.reduced_facts_present for s in scores), reduced_total
        ),
    }
    latency = p95([s.latency_ms for s in scores if s.latency_ms is not None])
    if latency is not None:
        out["stop_to_note_p95_ms"] = latency
    return out
