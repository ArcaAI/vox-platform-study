"""Multi-encounter note completeness: golden set metrics, runner and gate (no judge model)."""

from __future__ import annotations

from harness.eval.note_completeness.metrics import (
    GOLDEN_CASE_SHAPE,
    CaseScore,
    GoldenFact,
    GoldenReference,
    aggregate,
    p95,
    score_case,
)
from harness.eval.note_completeness.runner import (
    GOLDEN_FIXTURE,
    NOTE_COMPLETENESS_SCORER,
    CaseOutput,
    NoteCompletenessCaseInput,
    NoteCompletenessRun,
    NoteCompletenessThresholds,
    apply_thresholds,
    case_score_rows,
    load_golden_fixture,
    run_note_completeness,
    text_generate_fn,
)

__all__ = [
    "GOLDEN_CASE_SHAPE",
    "GOLDEN_FIXTURE",
    "NOTE_COMPLETENESS_SCORER",
    "CaseOutput",
    "CaseScore",
    "GoldenFact",
    "GoldenReference",
    "NoteCompletenessCaseInput",
    "NoteCompletenessRun",
    "NoteCompletenessThresholds",
    "aggregate",
    "apply_thresholds",
    "case_score_rows",
    "load_golden_fixture",
    "p95",
    "run_note_completeness",
    "score_case",
    "text_generate_fn",
]
