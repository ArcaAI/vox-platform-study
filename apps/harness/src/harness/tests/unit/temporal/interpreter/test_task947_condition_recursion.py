"""TASK-947 R1 #2 — a deeply nested ``when`` must be an EXCLUSION, never an escaped ``RecursionError``.

``evaluate_expression`` guarded ``_eval`` against ``RecursionError`` but not ``parse_expression``,
so a 244-character condition of 120 nested parentheses — under the 2 000-character cap — raised
straight through ``compose_prompt`` and the ``core.agent`` activity (OD-5: "never fatal"). The
evaluator is TOTAL again; publish additionally caps nesting at 64 on the TypeScript side.
"""

from __future__ import annotations

from harness.temporal.interpreter.expressions import (
    evaluate_condition,
    evaluate_expression,
    expression_problems,
)
from harness.temporal.interpreter.prompt_composition import compose_prompt

_DEEP = "(" * 400 + "true" + ")" * 400


class TestDeepNestingIsAnError:
    def test_evaluate_expression_answers_an_error_not_a_raise(self) -> None:
        result = evaluate_expression(_DEEP, {})
        assert result.error is not None
        assert "nested" in result.error

    def test_evaluate_condition_is_not_taken(self) -> None:
        taken, error = evaluate_condition(_DEEP, {})
        assert taken is False
        assert error is not None

    def test_expression_problems_names_it_too(self) -> None:
        problems = expression_problems(_DEEP)
        assert len(problems) == 1
        assert "nested" in problems[0]

    def test_compose_prompt_excludes_the_fragment_and_keeps_the_base(self) -> None:
        composed = compose_prompt(
            {
                "source": "composite",
                "content": "Base.",
                "join": "\n\n",
                "fragments": [
                    {"key": "base", "source": "inline", "content": "Base.", "when": None},
                    {"key": "deep", "source": "inline", "content": "Deep.", "when": _DEEP},
                ],
            },
            {},
            template_ref="agent:x",
        )
        assert composed.prompt == "Base."
        assert list(composed.selected) == ["base"]
        assert [(e.key, e.reason) for e in composed.excluded] == [("deep", "condition_error")]
