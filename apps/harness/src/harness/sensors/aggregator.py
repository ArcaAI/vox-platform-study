"""Verdict aggregator — fold sensor results into a fail-safe gate decision.

Decision policy (deterministic; clinical-safety > automation, per TASK-330 D2/D4):

* **degraded inputs** — a sensor could not verify (``SensorResult.degraded``), the
  caller signalled a degraded run (``degraded=True``), or an ``expected`` sensor is
  missing from the results — always ``FLAG``. The harness never auto-PASSes on
  missing/degraded inputs; it forces human review instead.
* **highest-harm failures** — a fabricated entity (``entity_faithfulness``), a
  numeric/dose mismatch (``numeric_dose``), or unsafe content (``safety``, the
  inferential Granite-Guardian gate) — ``FLAG``. These errors are dangerous and
  not safely auto-fixable, so they escalate to a clinician; unsafe content is
  **never** auto-regenerated.
* **regen-fixable failures** — invalid schema, omission, a missing citation, or
  ungrounded claims (``schema_validity`` / ``coverage_omission`` /
  ``citation_presence`` / ``groundedness``, the inferential entailment gate) —
  ``REGEN`` the implicated SOAP sections while regen budget remains; once the
  budget is exhausted (``regens_remaining <= 0``) they escalate to ``FLAG``.
* otherwise — ``PASS``.

The aggregator is pure: thresholds live on the sensors; the workflow owns the
regen budget and passes ``regens_remaining`` / ``degraded`` in. **Reduced
assurance** (Phase 2): when an inferential backend is unavailable its result is
``degraded`` — the *workflow* omits that inferential name from ``expected`` and
excludes the degraded result so the gate proceeds on the computational verdict
rather than a blanket FLAG (the omission is logged out-of-band via a
``REDUCED_ASSURANCE`` WORM event); it is never a silent auto-PASS.
"""

from __future__ import annotations

from collections.abc import Sequence
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from harness.sensors.base import SensorResult, dedupe
from harness.sensors.computational import (
    citation_presence,
    coverage_omission,
    entity_faithfulness,
    numeric_dose,
    schema_validity,
)

# SOAP section codes regenerated when a regen-fixable sensor fails without naming
# specific sections (i.e. regenerate the whole note).
DEFAULT_SOAP_SECTIONS: tuple[str, ...] = ("S", "O", "A", "P")

# Sensors whose failures are highest-harm -> escalate to a clinician (FLAG).
# ``"safety"`` is the inferential Granite-Guardian gate (unsafe content is never
# auto-regenerated). Inferential names are string literals (not imported) to keep
# this module pure/dependency-light; the aggregator tests import the sensors' NAME
# constants and assert membership here, guarding against drift.
HIGHEST_HARM_SENSORS: tuple[str, ...] = (entity_faithfulness.NAME, numeric_dose.NAME, "safety")

# Sensors whose failures are plausibly fixed by re-generating the note (REGEN).
# ``"groundedness"`` is the inferential per-claim entailment gate, and
# ``"citation_verify"`` is the Phase-3 per-claim citation-entailment gate (both
# regen the offending ``details["sections"]``, FLAG once the budget is exhausted).
# ``"atomic_fact"`` (TASK-481 E2) is the DETERMINISTIC reference-free atomic-claim
# entailment gate — an ungrounded atomic claim regens, then FLAGs on exhaustion (which
# the optimistic-delivery retraction contract turns into a draft retraction).
REGEN_FIXABLE_SENSORS: tuple[str, ...] = (
    schema_validity.NAME,
    coverage_omission.NAME,
    citation_presence.NAME,
    "groundedness",
    "citation_verify",
    "atomic_fact",
)


class GateDecision(StrEnum):
    """The harness gate outcome for one generated draft."""

    PASS = "PASS"
    REGEN = "REGEN"
    FLAG = "FLAG"


class Verdict(BaseModel):
    """The aggregated gate decision over a set of sensor results."""

    model_config = ConfigDict(extra="forbid")

    decision: GateDecision
    sections_to_regen: list[str] = Field(default_factory=list)
    claims_flagged: list[str] = Field(default_factory=list)
    scores: dict[str, float] = Field(default_factory=dict)


def _scores(results: Sequence[SensorResult]) -> dict[str, float]:
    return {r.name: round(r.score, 6) for r in results}


def aggregate(
    results: Sequence[SensorResult],
    *,
    regens_remaining: int | None = None,
    degraded: bool = False,
    expected: Sequence[str] | None = None,
) -> Verdict:
    """Combine ``results`` into a :class:`Verdict` using the fail-safe policy."""
    by_name = {r.name: r for r in results}
    scores = _scores(results)

    is_degraded = bool(degraded) or any(r.degraded for r in results)
    if expected is not None:
        is_degraded = is_degraded or any(name not in by_name for name in expected)
    if is_degraded:
        flagged = dedupe(claim for r in results for claim in r.claims_flagged)
        return Verdict(decision=GateDecision.FLAG, claims_flagged=flagged, scores=scores)

    harm_flagged: list[str] = []
    for name in HIGHEST_HARM_SENSORS:
        result = by_name.get(name)
        if result is not None and (not result.passed or result.claims_flagged):
            harm_flagged.extend(result.claims_flagged or [name])
    if harm_flagged:
        return Verdict(
            decision=GateDecision.FLAG, claims_flagged=dedupe(harm_flagged), scores=scores
        )

    failing = [
        by_name[name]
        for name in REGEN_FIXABLE_SENSORS
        if name in by_name and not by_name[name].passed
    ]
    if failing:
        flagged = dedupe(claim for r in failing for claim in r.claims_flagged)
        if regens_remaining is not None and regens_remaining <= 0:
            return Verdict(decision=GateDecision.FLAG, claims_flagged=flagged, scores=scores)
        sections = sorted({s for r in failing for s in r.details.get("sections", [])})
        if not sections:
            sections = list(DEFAULT_SOAP_SECTIONS)
        return Verdict(
            decision=GateDecision.REGEN,
            sections_to_regen=sections,
            claims_flagged=flagged,
            scores=scores,
        )

    return Verdict(decision=GateDecision.PASS, scores=scores)
