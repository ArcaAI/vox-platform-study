"""Pydantic mirrors of the NotePlan v1 and CoverageResult v1 wire contract.

The TypeScript composer (``packages/applications`` note-composition) writes a ``NotePlanV1``;
the harness reads it, runs its calls and answers with a ``CoverageResultV1``. Neither runtime can
import the other, so the committed fixture ``tests/contracts/note-plan.fixture.json`` IS the
contract: both mirrors parse every case in it.

The wire is camelCase; Python attributes are snake_case. ``to_wire()`` writes the camelCase shape
back with absent optionals omitted, which is what the fixture round-trip pins.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

#: The hard cap on calls in one plan (parallel section groups). The trajectory seq offsets
#: (``executor.CALL_STEP_OFFSET_BASE``) are sized for it.
MAX_NOTE_PLAN_CALLS = 10

NOTE_PLAN_SCHEMA: Literal["hope.note_plan.v1"] = "hope.note_plan.v1"
NOTE_COVERAGE_SCHEMA: Literal["hope.note_coverage.v1"] = "hope.note_coverage.v1"

NotePlanMode = Literal["final", "section_regen"]
BudgetStrategy = Literal[
    "single_pass", "ledger_prior", "section_groups", "ledger_prior+section_groups"
]
BlockRole = Literal[
    "pre_summary",
    "encounter_transcript",
    "encounter_ledger",
    "results",
    "attachment_transcript",
    "draft_clinician",
    "draft_ai",
]
CoverageStatus = Literal["complete", "gaps", "unchecked"]
GapKind = Literal[
    "missing_fact", "number_mismatch", "unresolved_citation", "ungrounded", "ledger_unavailable"
]


class _Wire(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
        frozen=True,
    )

    def to_wire(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


# ---------------------------------------------------------------------------------------------
# NotePlan v1
# ---------------------------------------------------------------------------------------------


class NotePlanModelRef(_Wire):
    slug: str
    wire_model_id: str
    provider: str
    context_window: int


class NotePlanTokenizer(_Wire):
    mode: Literal["exact", "estimate"]
    id: str


class NotePlanReduction(_Wire):
    kind: Literal["prior_encounter_to_ledger"]
    encounter_seq: int
    tokens_before: int
    tokens_after: int


class NotePlanBudget(_Wire):
    context_window: int
    single_pass_ratio: float
    safety_tokens: int
    input_tokens: int
    tokenizer: NotePlanTokenizer
    strategy: BudgetStrategy
    reductions: list[NotePlanReduction] = Field(default_factory=list)


class NotePlanEncounterSource(_Wire):
    seq: int
    visit_type: str
    segment_count: int
    ledger_item_id: str | None = None
    ledger_version: int | None = None
    rendered: Literal["verbatim", "ledger_cited"]


class ItemVersionRef(_Wire):
    context_item_id: str
    version_number: int


class NotePlanDraftSource(ItemVersionRef):
    clinician_sections: list[str] = Field(default_factory=list)
    ai_sections: list[str] = Field(default_factory=list)


class NotePlanSources(_Wire):
    encounters: list[NotePlanEncounterSource] = Field(default_factory=list)
    results: list[ItemVersionRef] = Field(default_factory=list)
    attachment_transcripts: list[ItemVersionRef] = Field(default_factory=list)
    draft: NotePlanDraftSource | None = None
    pre_summary: ItemVersionRef | None = None


class NotePlanBlock(_Wire):
    key: str
    role: BlockRole
    label: str
    content: str
    tokens: int


class NotePlanHeading(_Wire):
    key: str
    title: str


class NotePlanCall(_Wire):
    call_id: str
    section_keys: list[str] = Field(min_length=1)
    directive: str
    max_tokens: int
    prompt_tokens: int


class CoverageNumber(_Wire):
    value: str
    unit: str | None = None


class CriticalFact(_Wire):
    fact_id: str
    encounter_seq: int
    key: str
    kind: str
    anchors: list[str] = Field(default_factory=list)
    numbers: list[CoverageNumber] = Field(default_factory=list)
    citations: list[str] = Field(default_factory=list)
    # Optional ledger hint (ledger v1 ``sectionHint``): the heading the fact belongs under.
    section_hint: str | None = None


class SourceId(_Wire):
    id: str
    v: int
    kind: str


class NotePlanCoverage(_Wire):
    #: ``None`` means the ledger the facts come from was NOT available (the check is then
    #: ``unchecked``); an empty list means it was available and holds no critical fact.
    critical_facts: list[CriticalFact] | None = None
    source_ids: dict[str, SourceId] = Field(default_factory=dict)
    repair_passes: int = Field(default=1, ge=0, le=1)


class NotePlanPreserve(ItemVersionRef):
    section_keys: list[str] = Field(default_factory=list)


class NotePlanV1(_Wire):
    schema_id: Literal["hope.note_plan.v1"] = Field(alias="schema")
    plan_id: str
    consultation_id: str
    tenant_id: str
    input_digest: str
    mode: NotePlanMode
    model: NotePlanModelRef
    budget: NotePlanBudget
    sources: NotePlanSources
    system: str | None = None
    blocks: list[NotePlanBlock]
    headings: list[NotePlanHeading] = Field(min_length=1)
    calls: list[NotePlanCall] = Field(min_length=1, max_length=MAX_NOTE_PLAN_CALLS)
    coverage: NotePlanCoverage
    preserve: NotePlanPreserve | None = None

    @model_validator(mode="after")
    def _calls_partition_the_headings(self) -> NotePlanV1:
        heading_keys = [h.key for h in self.headings]
        if len(set(heading_keys)) != len(heading_keys):
            raise ValueError("note plan headings repeat a key")
        called: list[str] = [key for call in self.calls for key in call.section_keys]
        unknown = sorted(set(called) - set(heading_keys))
        if unknown:
            raise ValueError(f"note plan calls name unknown headings: {unknown}")
        if len(set(called)) != len(called):
            raise ValueError("note plan calls write the same heading twice")
        preserved = list(self.preserve.section_keys) if self.preserve else []
        if set(preserved) & set(called):
            raise ValueError("note plan both preserves and regenerates a heading")
        if self.mode == "final" and set(called) != set(heading_keys):
            raise ValueError("a final note plan must write every heading")
        if self.mode == "section_regen":
            if self.preserve is None:
                raise ValueError("a section_regen note plan must name what it preserves")
            if set(called) | set(preserved) != set(heading_keys):
                raise ValueError("a section_regen note plan must write or preserve every heading")
        return self

    def heading_title(self, key: str) -> str:
        return next((h.title for h in self.headings if h.key == key), key)


class NotePlanRef(_Wire):
    """The pointer the harness receives instead of the plan (the plan itself stays in Redis)."""

    consultation_id: str
    plan_id: str
    mode: NotePlanMode = "final"


# ---------------------------------------------------------------------------------------------
# CoverageResult v1
# ---------------------------------------------------------------------------------------------


class CoverageFactCounts(_Wire):
    total: int = 0
    present: int = 0
    missing: list[str] = Field(default_factory=list)


class CoverageNumberCounts(_Wire):
    total: int = 0
    matched: int = 0
    unsupported: int = 0


class CoverageCitationCounts(_Wire):
    total: int = 0
    resolved: int = 0
    unresolved: list[str] = Field(default_factory=list)


class CoverageGroundedness(_Wire):
    score: float
    passed: bool


class CoverageGap(_Wire):
    kind: GapKind
    fact_id: str | None = None
    section_key: str | None = None
    segment_ids: list[str] | None = None
    #: Clinical wording — encrypted at rest by apps/api, and never logged here.
    detail: str


class CoverageResultV1(_Wire):
    schema_id: Literal["hope.note_coverage.v1"] = Field(
        default=NOTE_COVERAGE_SCHEMA, alias="schema"
    )
    status: CoverageStatus
    repair_passes: int = Field(ge=0, le=1)
    critical_facts: CoverageFactCounts = Field(default_factory=CoverageFactCounts)
    numbers: CoverageNumberCounts = Field(default_factory=CoverageNumberCounts)
    citations: CoverageCitationCounts = Field(default_factory=CoverageCitationCounts)
    groundedness: CoverageGroundedness | None = None
    gaps: list[CoverageGap] = Field(default_factory=list)
