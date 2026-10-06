"""TASK-1034 R3 — the clinician's redaction rules reach the finalizer PROMPT as text.

The live handoff emits ``dna_redaction_rules_text`` (a bullet list rendered gateway-side behind the
redaction gate) next to ``dna_style_text``. Nothing in the harness may drop it between the
handoff answer and the rendered system prompt: ``LiveOutputsResult.context`` is an open dict,
``WorkflowInterpreter._run_context`` overlays it onto ``trigger`` AND ``trigger.context``, and the
finalize instruction binds ``{{context.dna_redaction_rules_text | default("")}}``. The
deterministic post-generation redaction is untouched — this is the advisory half only.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from harness.temporal.interpreter.models import LiveOutputsResult
from harness.temporal.interpreter.nodes import core
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal.interpreter.test_core_agent_templating_task890 import _resolved

_RULES = '- Never write "Ms. Ada Byron".\n- Always write "pt" as "patient".'
_BLOCK = 'Never include / always rewrite:\n{{context.dna_redaction_rules_text | default("")}}\nEND'


def _run_context_after_handoff(handoff_context: dict[str, Any]) -> dict[str, Any]:
    """The REAL `_run_context`, over a trigger node output and a parsed handoff answer."""
    answer = LiveOutputsResult.model_validate({"ended": True, "context": handoff_context})
    fake = SimpleNamespace(
        _node_outputs={"n_trigger": {"context": {"consultationId": "c-1"}}},
        _node_types={"n_trigger": "core.trigger"},
        _live_context=dict(answer.context),
    )
    return WorkflowInterpreter._run_context(fake)  # type: ignore[arg-type]


class TestDnaRedactionRulesText:
    def test_the_rules_text_reaches_the_rendered_prompt_when_the_handoff_carries_it(self) -> None:
        context = _run_context_after_handoff(
            {"dna_style_text": "Terse.", "dna_redaction_rules_text": _RULES}
        )

        assert context["trigger"]["context"]["dna_redaction_rules_text"] == _RULES
        prompt = core._system_prompt(_resolved(_BLOCK), {}, context)
        # FC-1: the system prompt points; the rules text rides in the user message data block.
        assert prompt == (
            "Never include / always rewrite:\n"
            "[see the context_dna_redaction_rules_text data section below]\nEND"
        )

    def test_the_block_renders_empty_when_the_handoff_carries_no_rules(self) -> None:
        context = _run_context_after_handoff({"dna_style_text": "Terse."})

        assert "dna_redaction_rules_text" not in context["trigger"]
        prompt = core._system_prompt(_resolved(_BLOCK), {}, context)
        assert prompt == (
            "Never include / always rewrite:\n"
            "[see the context_dna_redaction_rules_text data section below]\nEND"
        )
