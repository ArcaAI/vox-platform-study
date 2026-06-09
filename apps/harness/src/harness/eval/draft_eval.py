"""Bridge a harness-produced draft into the Phase-0 eval harness (Lane F).

A harness "draft" is the generated SOAP note plus the transcript it was grounded
in. This module gives two ways to score such a draft against the eval harness's
golden-set model:

1. :func:`harness_draft_to_golden_case` adapts a loop draft into the eval
   harness's :class:`~harness.eval.models.GoldenCase`, so the existing
   :class:`~harness.eval.golden.runner.GoldenSetRunner` / ``run_and_gate``
   (PDSQI-9 judge + RAGAS-style faithfulness) can score it. Those two metrics
   are LLM-as-judge, so they need a live judge model endpoint
   (``HARNESS_JUDGE_*``); when one is configured the synthetic fixture (or, for a
   real clinical delta, the SME-authored golden set) runs through unchanged.

2. :func:`score_golden_set_with_sensors` runs the harness's deterministic
   *computational* sensors (Lane H) over each golden case — the SAME sensors that
   gate the live loop. This path is fully offline (no model, no network), so it
   produces a reproducible groundedness/fail-safe signal here and now. Note the
   entity-level sensors key on NER spans; offline (no NLP service) those inputs
   are empty, so the fail-safe aggregator FLAGs (never auto-PASSes) — exactly the
   degradation policy in the design.

Run it: ``python -m harness.eval.draft_eval`` scores the packaged synthetic
golden set with the computational sensors and prints a per-case table.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from harness.eval.golden.sources import GoldenSetSource, default_golden_set_source
from harness.eval.models import GoldenCase, GoldenSet
from harness.sensors.aggregator import GateDecision, aggregate
from harness.sensors.base import NEREntity
from harness.sensors.config import SensorThresholds
from harness.sensors.registry import COMPUTATIONAL_SENSOR_NAMES
from harness.services.sensor_runner import run_computational_sensors


def harness_draft_to_golden_case(
    *,
    case_id: str,
    note_text: str,
    transcript_text: str,
    target_specialty: str = "General Medicine",
    reference_note: str | None = None,
    contexts: Sequence[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> GoldenCase:
    """Adapt a harness loop draft into an eval-harness :class:`GoldenCase`.

    The transcript is the grounding source; the generated note is the summary
    under evaluation. Pass extra grounding (e.g. prior notes) via ``contexts``.
    """
    return GoldenCase(
        case_id=case_id,
        source_documents=[transcript_text],
        generated_note=note_text,
        target_specialty=target_specialty,
        reference_note=reference_note,
        contexts=list(contexts) if contexts is not None else None,
        metadata=metadata or {},
    )


class SensorEvalCaseResult(BaseModel):
    """The computational-sensor scoring of one draft↔transcript pair."""

    model_config = ConfigDict(extra="forbid")

    case_id: str
    decision: str
    passed: bool
    scores: dict[str, float] = Field(default_factory=dict)
    sections_to_regen: list[str] = Field(default_factory=list)
    claims_flagged: list[str] = Field(default_factory=list)


def score_draft_with_sensors(
    *,
    case_id: str,
    note_text: str,
    transcript_text: str,
    note_entities: Sequence[NEREntity] = (),
    transcript_entities: Sequence[NEREntity] = (),
    response_format: dict[str, Any] | None = None,
    thresholds: SensorThresholds | None = None,
) -> SensorEvalCaseResult:
    """Score one draft with the five computational sensors + fold the verdict.

    Single-shot scoring (``regens_remaining=0``): regen-fixable failures escalate
    to FLAG, mirroring an eval pass that does not re-generate.
    """
    out = run_computational_sensors(
        note_text=note_text,
        transcript_text=transcript_text,
        note_entities=list(note_entities),
        transcript_entities=list(transcript_entities),
        response_format=response_format,
        thresholds=thresholds,
    )
    verdict = aggregate(
        out.results,
        regens_remaining=0,
        degraded=False,
        expected=list(COMPUTATIONAL_SENSOR_NAMES),
    )
    return SensorEvalCaseResult(
        case_id=case_id,
        decision=str(verdict.decision),
        passed=verdict.decision == GateDecision.PASS,
        scores=out.scores,
        sections_to_regen=verdict.sections_to_regen,
        claims_flagged=verdict.claims_flagged,
    )


def score_golden_case_with_sensors(
    case: GoldenCase, *, thresholds: SensorThresholds | None = None
) -> SensorEvalCaseResult:
    """Score one golden case's note against its (joined) source documents."""
    return score_draft_with_sensors(
        case_id=case.case_id,
        note_text=case.generated_note,
        transcript_text="\n\n".join(case.source_documents),
        thresholds=thresholds,
    )


def score_golden_set_with_sensors(
    golden_set: GoldenSet, *, thresholds: SensorThresholds | None = None
) -> list[SensorEvalCaseResult]:
    """Score every case of a golden set with the computational sensors."""
    return [score_golden_case_with_sensors(c, thresholds=thresholds) for c in golden_set.cases]


def _run(source: GoldenSetSource | None = None) -> int:
    """CLI: score the (synthetic) golden set with the computational sensors."""
    source = source or default_golden_set_source()
    golden_set = source.load()
    results = score_golden_set_with_sensors(golden_set)

    print(f"[draft-eval] computational-sensor pass over golden set '{golden_set.version}'")
    print(f"[draft-eval] cases={len(results)}  (offline: no NLP/NER, no judge model)")
    for r in results:
        score_str = ", ".join(f"{k}={v:.3f}" for k, v in r.scores.items())
        print(f"  - {r.case_id}: decision={r.decision}  [{score_str}]")

    decisions: dict[str, int] = {}
    for r in results:
        decisions[r.decision] = decisions.get(r.decision, 0) + 1
    print(f"[draft-eval] decision tally: {decisions}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    import sys

    sys.exit(_run())
