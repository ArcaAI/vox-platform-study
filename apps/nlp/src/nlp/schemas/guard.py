"""Guardrail-class model schemas ( Phases 3 & 6).

`apps/nlp` is the EXECUTOR for the guardrail plane, never its policy owner
(decision D3). Every request here carries, from the caller:

* the runtime model id (`model_name`, the resolved `AiModel.sourceUri`) and
  optional staged weights path (`model_path`) — exactly the shape
  `/classify/{text,tokens}` already uses;
* the LABEL TAXONOMY / task schema to run — guardrail resolves it tenant-first
  from the registry and owns it as policy;
* the `tenant_id` the work is attributable to.

Nothing in this module carries a model id, a label set or a threshold of its
own: those are configuration, and configuration does not live in code
(`.claude/rules/00-project-context.md` §Configuration Principles).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from nlp.schemas.common import DeviceLabel
from nlp.services.entailment_scorer import EntailmentCalibration


class _GuardModelSelection(BaseModel):
    """The caller-resolved weight identity + attribution shared by every route."""

    model_name: str | None = Field(
        default=None,
        description="Resolved AiModel.sourceUri. Absent ⇒ 503 (selection is fail-closed).",
    )
    model_path: str | None = Field(
        default=None,
        description="Optional staged weights directory (AiModel.localPath)",
    )
    tenant_id: str | None = Field(
        default=None,
        description="Tenant the decision is attributable to. Absent ⇒ 428.",
    )
    # WHICH SERVICE CLASS this call belongs to, not a priority the
    #: caller may claim for speed's sake — the two lanes have different queue
    #: geometries AND different declared wait ceilings, so `interactive` is also
    #: a promise to accept a 503 sooner. Absent ⇒ `bulk`, which is exactly the
    # behaviour, so an existing caller is unaffected.
    latency_class: Literal["interactive", "bulk"] | None = Field(
        default=None,
        description=(
            "Service class: 'interactive' for a synchronous inline gate (small "
            "batch, short linger, short wait ceiling), 'bulk' for the "
            "asynchronous per-utterance pass. Absent ⇒ 'bulk'."
        ),
    )


# ── PII / entity spans (GLiNER2) ─────────────────────────────────────────


class GuardPiiRequest(_GuardModelSelection):
    text: str = Field(..., description="Text to scan")
    labels: list[str] = Field(
        default_factory=list,
        description="The PII label taxonomy to detect (caller policy). Empty ⇒ 503.",
    )
    threshold: float = Field(
        default=0.5, ge=0.0, le=1.0, description="Caller-supplied detection threshold"
    )


class GuardEntity(BaseModel):
    """One detected span. Offsets index the SUBMITTED `text` byte-exactly."""

    label: str
    start: int
    end: int
    score: float
    text: str


class GuardPiiResponse(BaseModel):
    entities: list[GuardEntity]
    model_version: str
    inference_ms: int = Field(
        ...,
        ge=0,
        description=(
            "Wall-clock model inference time in milliseconds (TASK-959). This "
            "route runs behind a MicroBatcher, so this is the request's SHARE of "
            "the batched forward pass (pass wall time / requests in the batch), "
            "never the whole pass's time."
        ),
    )
    device: DeviceLabel = Field(..., description="Resolved inference device placement (TASK-959)")


# ── Safety / moderation classification (GLiNER2 classify_text) ───────────


class GuardTaskSpec(BaseModel):
    """One classification task, exactly as the caller's policy defines it."""

    labels: list[str] = Field(..., min_length=1)
    multi_label: bool = Field(default=False)
    cls_threshold: float | None = Field(default=None, ge=0.0, le=1.0)


class GuardClassifyRequest(_GuardModelSelection):
    text: str = Field(..., description="Text to moderate")
    tasks: dict[str, GuardTaskSpec] = Field(
        default_factory=dict,
        description="task name → label spec (caller policy). Empty ⇒ 503.",
    )
    threshold: float = Field(default=0.5, ge=0.0, le=1.0)


class GuardClassifyResponse(BaseModel):
    #: task name → a single label (single-label) or a list (multi-label). Only
    #: the tasks that were REQUESTED appear; nothing is invented.
    results: dict[str, str | list[str]]
    #: task name → {label: confidence} for the labels present in `results`
    # . ADDITIVE: `results` is unchanged, because three guardrail
    #: call sites parse it as `str | list[str]` and a reshape would have them
    #: comparing `str(dict)` against their benign-label set.
    #:
    #: NOT a distribution over the whole taxonomy. `gliner2` returns the argmax
    #: label for a single-label task and only the labels at/above `cls_threshold`
    #: for a multi-label one, so what is scored here is exactly what was
    #: RETURNED. Deriving a risk number from it (e.g. `1 - confidence` when the
    #: winning label is benign) is the CALLER's policy, as every threshold on
    #: this surface already is.
    #:
    #: A task the runtime reported without a confidence is simply absent — never
    #: a substituted 0.0, which would read as "the model was certain of nothing".
    scores: dict[str, dict[str, float]] = Field(
        default_factory=dict,
        description="task → {label: confidence} for the labels in `results`. Absent ⇒ unscored.",
    )
    model_version: str
    inference_ms: int = Field(
        ...,
        ge=0,
        description=(
            "Wall-clock model inference time in milliseconds (TASK-959). This "
            "route runs behind a MicroBatcher, so this is the request's SHARE of "
            "the batched forward pass (pass wall time / requests in the batch), "
            "never the whole pass's time."
        ),
    )
    device: DeviceLabel = Field(..., description="Resolved inference device placement (TASK-959)")


# ── NLI entailment (MiniCheck) ───────────────────────────────────────────


class GuardEntailmentPair(BaseModel):
    document: str
    claim: str


class GuardEntailmentRequest(_GuardModelSelection):
    pairs: list[GuardEntailmentPair] = Field(default_factory=list)
    #: The selected checkpoint's `AiModel._metadata.entailment` — the calibration
    #: gate's ground truth (adapter id, expected label-token ids, direction+margin
    #: tolerances, reference pair). It rides with the SELECTION, exactly as
    #: `labelTaxonomy` does for the PII/safety routes, because tolerances measured
    #: on one quantisation are meaningless for another. Absent ⇒ 503: this service
    #: will not score a checkpoint against another model's calibration.
    calibration: EntailmentCalibration | None = Field(
        default=None,
        description="AiModel._metadata.entailment for the selected checkpoint. Absent => 503.",
    )


class GuardEntailmentResponse(BaseModel):
    #: `P(claim entailed by document)` per pair, in request order. The caller
    #: (guardrail) owns the threshold that turns a score into a verdict.
    scores: list[float]
    model_version: str
    inference_ms: int = Field(
        ...,
        ge=0,
        description=(
            "Wall-clock model inference time in milliseconds (TASK-959). 0 when "
            "`pairs` was empty (no inference ran)."
        ),
    )
    device: DeviceLabel = Field(..., description="Resolved inference device placement (TASK-959)")
