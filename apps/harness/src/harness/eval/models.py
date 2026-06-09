"""Shared Pydantic models for the eval harness.

These are the in-process value objects the harness emits to files / stdout. They
intentionally do **not** depend on ``packages/*`` or the Postgres ``EvalRun`` /
``EvalScore`` schema — DB persistence of eval runs is a later phase via
``apps/api``. The field names mirror the persisted schema closely so a later
adapter is trivial.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# PDSQI-9 dimensions (Epic open-source instrument). Eight 1–5 Likert quality
# dimensions, plus three categorical flags (abstraction need + stigmatizing
# language in summary/notes). ``synthesized`` may be "NA" (→ None) when no
# abstraction is required.
PDSQI_LIKERT_DIMENSIONS: tuple[str, ...] = (
    "citation",
    "accurate",
    "thorough",
    "useful",
    "organized",
    "comprehensible",
    "succinct",
    "synthesized",
)
PDSQI_BINARY_DIMENSIONS: tuple[str, ...] = ("abstraction", "voice_summ", "voice_note")
PDSQI_DIMENSIONS: tuple[str, ...] = PDSQI_LIKERT_DIMENSIONS + PDSQI_BINARY_DIMENSIONS


class PDSQIScore(BaseModel):
    """A single PDSQI-9 judgement of one summary."""

    model_config = ConfigDict(extra="forbid")

    citation: int
    accurate: int
    thorough: int
    useful: int
    organized: int
    comprehensible: int
    succinct: int
    synthesized: int | None = None  # None == "NA" (no abstraction required)
    abstraction: int
    voice_summ: int
    voice_note: int

    justifications: dict[str, str] = Field(default_factory=dict)

    @field_validator(
        "citation", "accurate", "thorough", "useful", "organized", "comprehensible", "succinct"
    )
    @classmethod
    def _likert_1_5(cls, v: int, info) -> int:  # type: ignore[no-untyped-def]
        if not (1 <= v <= 5):
            raise ValueError(f"{info.field_name} must be a 1–5 Likert score, got {v}")
        return v

    @field_validator("synthesized")
    @classmethod
    def _synthesized_range(cls, v: int | None) -> int | None:
        if v is not None and not (1 <= v <= 5):
            raise ValueError(f"synthesized must be 1–5 or None (NA), got {v}")
        return v

    @field_validator("abstraction", "voice_summ", "voice_note")
    @classmethod
    def _binary(cls, v: int, info) -> int:  # type: ignore[no-untyped-def]
        if v not in (0, 1):
            raise ValueError(f"{info.field_name} must be 0 or 1, got {v}")
        return v

    def likert_items(self) -> dict[str, int]:
        """The present 1–5 Likert dimensions (excludes ``synthesized`` when NA)."""
        out: dict[str, int] = {}
        for dim in PDSQI_LIKERT_DIMENSIONS:
            val = getattr(self, dim)
            if val is not None:
                out[dim] = int(val)
        return out

    def mean_quality(self) -> float:
        """Mean of the present 1–5 Likert quality dimensions."""
        items = self.likert_items()
        return sum(items.values()) / len(items) if items else 0.0


class PDSQIResult(BaseModel):
    """The judge's scoring of one golden case."""

    case_id: str
    score: PDSQIScore
    model: str
    raw_response: str = ""


class GoldenCase(BaseModel):
    """A transcript→note evaluation case.

    ``source_documents`` are the grounding sources (transcript turns + prior
    notes); ``generated_note`` is the summary under evaluation. ``clinician_pdsqi``
    holds the reference PDSQI ratings used for judge calibration.

    ``role`` separates two distinct eval purposes (see
    ``apps/harness/eval/README.md``):

    * ``"quality"`` — the ``generated_note`` is a high-quality reference exemplar
      representative of good production output. These cases feed the PDSQI
      *quality* aggregates (accurate/thorough/mean) and the faithfulness gate.
    * ``"calibration"`` — a range-spanning / adversarial case whose
      ``generated_note`` may exhibit a deliberate flaw. These cases feed the
      judge↔reference agreement (ICC / Gwet AC2) ONLY; they are excluded from the
      quality aggregates so the quality gate is not graded on sabotaged inputs.
    """

    model_config = ConfigDict(extra="forbid")

    case_id: str
    source_documents: list[str]
    generated_note: str
    target_specialty: str = "General Medicine"
    role: Literal["quality", "calibration"] = "quality"
    reference_note: str | None = None
    contexts: list[str] | None = None
    clinician_pdsqi: PDSQIScore | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _non_empty(self) -> GoldenCase:
        if not self.source_documents:
            raise ValueError(f"case {self.case_id}: source_documents must be non-empty")
        if not self.generated_note.strip():
            raise ValueError(f"case {self.case_id}: generated_note must be non-empty")
        return self

    def faithfulness_contexts(self) -> list[str]:
        """Context used for faithfulness checks (transcript ∪ evidence)."""
        return self.contexts if self.contexts is not None else self.source_documents


class GoldenSet(BaseModel):
    """A versioned, pluggable collection of golden cases.

    ``version`` is pinned by CI so eval results are comparable across runs.
    """

    model_config = ConfigDict(extra="forbid")

    version: str
    name: str = "golden-set"
    description: str = ""
    cases: list[GoldenCase]

    @model_validator(mode="after")
    def _non_empty(self) -> GoldenSet:
        if not self.cases:
            raise ValueError("golden set must contain at least one case")
        ids = [c.case_id for c in self.cases]
        if len(ids) != len(set(ids)):
            raise ValueError("golden set case_ids must be unique")
        return self


class FaithfulnessResult(BaseModel):
    """RAGAS-style faithfulness for one summary."""

    case_id: str
    score: float
    supported_claims: int
    total_claims: int
    claims: list[str] = Field(default_factory=list)
    unsupported: list[str] = Field(default_factory=list)


class EvalCaseResult(BaseModel):
    """All metrics for one case."""

    case_id: str
    pdsqi: PDSQIResult | None = None
    faithfulness: FaithfulnessResult | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class EvalRunResult(BaseModel):
    """Aggregate of an eval run over a (pinned) golden set."""

    golden_set_version: str
    judge_model: str
    case_results: list[EvalCaseResult]
    aggregates: dict[str, float] = Field(default_factory=dict)
    thresholds: dict[str, float] = Field(default_factory=dict)
    passed: bool = True
    failures: list[str] = Field(default_factory=list)
