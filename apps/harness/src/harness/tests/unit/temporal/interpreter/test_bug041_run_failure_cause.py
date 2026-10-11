"""BUG-041 — a run whose finalizer degraded reported `OUTPUT_INVALID`, hiding the real cause.

On the dev cluster (2026-10-09) `n_finalize` degraded with `note_plan_call_failed` while
hope-text answered `503 CONCURRENCY_LIMIT`. The note was never written, so `core.output` then
failed on `'case_note' is a required property`, and THAT became the run's error code. The missing
field is the symptom; the degraded upstream node is the cause.
"""

from __future__ import annotations

from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.models import NodeResult, StageResult
from harness.temporal.interpreter.workflow import _run_failure_cause

_FINALIZE_DEGRADED = "core.agent: note_plan_call_failed: note plan call(s) failed: ['g1', 'g2']"
_OUTPUT_MISSING_FIELD = (
    "activity_error: OutputSchemaViolation: core.output: result violates the declared output "
    "schema: (root): 'case_note' is a required property"
)
_OUTPUT_WRONG_TYPE = (
    "activity_error: OutputSchemaViolation: core.output: result violates the declared output "
    "schema: case_note: 42 is not of type 'string'"
)


def _node(node_id: str, status: str, reason: str | None = None) -> NodeResult:
    return NodeResult(node_id=node_id, node_type="core.agent", status=status, reason=reason)


def _run(*stages: list[NodeResult]) -> list[StageResult]:
    return [StageResult(stage_index=i, nodes=nodes) for i, nodes in enumerate(stages)]


class TestRunErrorCode:
    def test_a_failed_note_plan_is_a_model_error(self) -> None:
        assert interpreter_activities.run_error_code_of(_FINALIZE_DEGRADED) == "MODEL_ERROR"

    def test_a_truncated_or_empty_note_is_a_model_error(self) -> None:
        for code in ("note_output_truncated", "note_empty"):
            reason = f"core.agent: {code}: the note plan wrote no section"
            assert interpreter_activities.run_error_code_of(reason) == "MODEL_ERROR"

    def test_an_output_schema_violation_is_still_output_invalid(self) -> None:
        assert interpreter_activities.run_error_code_of(_OUTPUT_MISSING_FIELD) == "OUTPUT_INVALID"
        assert (
            interpreter_activities.run_error_code_of("io_schema_violation: (root): bad")
            == "OUTPUT_INVALID"
        )

    def test_the_bare_word_schema_is_not_a_schema_violation(self) -> None:
        reason = "core.agent: model `x` did not resolve: context schema v3 is not published"
        assert interpreter_activities.run_error_code_of(reason) == "INTERNAL_ERROR"


class TestRunFailureCause:
    def test_the_first_failed_node_is_the_cause_by_default(self) -> None:
        stages = _run(
            [_node("n_a", "SUCCEEDED")],
            [_node("n_b", "FAILED", "core.agent: text generate failed on every candidate")],
        )
        assert _run_failure_cause(stages) == "core.agent: text generate failed on every candidate"

    def test_a_missing_output_field_names_the_degraded_finalizer_instead(self) -> None:
        stages = _run(
            [_node("n_ner", "SUCCEEDED")],
            [_node("n_finalize", "DEGRADED", _FINALIZE_DEGRADED)],
            [_node("n_output", "FAILED", _OUTPUT_MISSING_FIELD)],
        )
        cause = _run_failure_cause(stages)
        assert cause == _FINALIZE_DEGRADED
        assert interpreter_activities.run_error_code_of(cause) == "MODEL_ERROR"

    def test_a_wrong_typed_field_stays_output_invalid(self) -> None:
        # The node DID produce the field; the model wrote the wrong shape. That IS the cause.
        stages = _run(
            [_node("n_finalize", "DEGRADED", _FINALIZE_DEGRADED)],
            [_node("n_output", "FAILED", _OUTPUT_WRONG_TYPE)],
        )
        assert _run_failure_cause(stages) == _OUTPUT_WRONG_TYPE

    def test_an_unclassifiable_degrade_does_not_replace_the_violation(self) -> None:
        stages = _run(
            [_node("n_misc", "DEGRADED", "something odd happened")],
            [_node("n_output", "FAILED", _OUTPUT_MISSING_FIELD)],
        )
        assert _run_failure_cause(stages) == _OUTPUT_MISSING_FIELD

    def test_a_degrade_after_the_failure_is_not_its_cause(self) -> None:
        stages = _run(
            [_node("n_output", "FAILED", _OUTPUT_MISSING_FIELD)],
            [_node("n_later", "DEGRADED", _FINALIZE_DEGRADED)],
        )
        assert _run_failure_cause(stages) == _OUTPUT_MISSING_FIELD

    def test_no_failed_node_has_no_cause(self) -> None:
        assert _run_failure_cause(_run([_node("n_a", "DEGRADED", _FINALIZE_DEGRADED)])) is None
