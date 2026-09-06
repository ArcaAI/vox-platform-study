"""TASK-890 §3.2/§3.3 — `core.agent`'s system prompt renders through the ONE grammar.

Before this ticket the durable lane carried its own resolver (`core.interpolate_template`, the
sixth templating flavour of §2.4) which left an unresolved `{{path}}` VERBATIM in the prompt and
knew nothing of `default("…")`, of `{{{{` escaping, or of the `context` alias. The gateway's
realtime lane carried a seventh, flat-key copy. This module pins the durable half of the fix:

1. `_system_prompt` renders through `templating.render_template` — the module held to
   `tests/contracts/prompt-template.fixture.json` by `test_templating_parity.py`;
2. the run env stays `{trigger, vars, nodes}` (§3.3) and gains the `context` ALIAS, so one
   prompt is portable between a workflow run (`{{trigger.x}}`) and a standalone agent
   invocation (`{{context.x}}`);
3. an unresolved, undefaulted variable RAISES `PromptVariableUnresolved` rather than shipping a
   literal `{{…}}` to the model — the activity turns that into a DEGRADED step with
   `error_code=prompt_variable_unresolved` (`_run_text_generation`), never a crash and never a
   silent half-prompt;
4. `core.interpolate_template` is GONE (§3.11): there is one renderer, in `templating.py`.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput, ResolvedAgent
from harness.temporal.interpreter.nodes import core
from harness.temporal.interpreter.templating import PromptVariableUnresolved

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"


def _resolved(prompt: str, variables: dict[str, Any] | None = None) -> ResolvedAgent:
    return ResolvedAgent.model_validate(
        {
            "agentId": "agent-1",
            "agentVersionId": "agent-1",
            "slug": "discharge-writer",
            "versionNumber": 1,
            "task": "TEXT_GENERATION",
            "tenantId": _TENANT,
            "source": "tenant",
            "compiledConfig": {
                "task": "TEXT_GENERATION",
                "service": "llm",
                "model": {
                    "id": "m-1",
                    "slug": "gpt-x",
                    "provider": "openai",
                    "taskType": "text-generation",
                },
                "fallbacks": [],
                "instruction": {
                    "systemPrompt": prompt,
                    **({"variables": variables} if variables is not None else {}),
                },
                "resolvedPrompt": {"source": "inline", "content": prompt},
                "parameters": {},
                "inputSchema": {"type": "object"},
                "outputSchema": {"type": "string"},
                "tools": [],
                "protocols": ["http"],
            },
            "models": [
                {
                    "role": "primary",
                    "priority": 0,
                    "slug": "gpt-x",
                    "sourceUri": "openai/gpt-x",
                    "provider": "openai",
                    "format": "CLOUD",
                    "tenantId": _TENANT,
                }
            ],
        }
    )


def _run_context() -> dict[str, Any]:
    """The workflow's run env exactly as `InterpreterWorkflow._run_context` builds it."""
    return {
        "trigger": {"patientAge": 41, "patient": {"name": "Ada"}},
        "vars": {"tone": "formal"},
        "nodes": {"n1": {"text": "prior note"}},
    }


class TestCoreAgentTemplating:
    def test_a_dotted_trigger_path_renders_its_value(self) -> None:
        prompt = core._system_prompt(
            _resolved("Patient is {{trigger.patient.name}}, age {{trigger.patientAge}}."),
            {},
            _run_context(),
        )

        assert prompt == "Patient is Ada, age 41."

    def test_context_is_an_alias_of_trigger(self) -> None:
        """§3.3 — one prompt is portable between a run and a standalone invocation."""
        context = _run_context()
        by_trigger = core._system_prompt(_resolved("{{trigger.patient.name}}"), {}, context)
        by_context = core._system_prompt(_resolved("{{context.patient.name}}"), {}, context)

        assert by_trigger == by_context == "Ada"

    def test_vars_and_nodes_namespaces_render(self) -> None:
        prompt = core._system_prompt(
            _resolved("{{vars.tone}} / {{nodes.n1.text}}"), {}, _run_context()
        )

        assert prompt == "formal / prior note"

    def test_a_bare_bound_variable_still_renders_and_the_node_override_wins(self) -> None:
        prompt = core._system_prompt(
            _resolved("Ward {{ward}}", {"ward": "3"}),
            {"overrides": {"promptVariables": {"ward": "7"}}},
            _run_context(),
        )

        assert prompt == "Ward 7"

    def test_an_unresolved_variable_raises_instead_of_shipping_a_literal(self) -> None:
        with pytest.raises(PromptVariableUnresolved) as excinfo:
            core._system_prompt(_resolved("{{trigger.absent}}"), {}, _run_context())

        assert excinfo.value.path == "trigger.absent"

    def test_a_default_covers_an_absent_path(self) -> None:
        prompt = core._system_prompt(
            _resolved('{{trigger.absent | default("n/a")}}'), {}, _run_context()
        )

        assert prompt == "n/a"

    def test_a_single_brace_is_literal(self) -> None:
        """§3.11 — the deleted single-brace grammar is not honoured by a fallback pass."""
        prompt = core._system_prompt(_resolved("Language: {language_name}"), {}, _run_context())

        assert prompt == "Language: {language_name}"

    def test_the_local_interpolator_is_gone(self) -> None:
        """§3.11 — flavour 6 is re-hosted in `templating.py`; `core` keeps no copy."""
        assert not hasattr(core, "interpolate_template")


class TestCoreAgentDegradesOnAnUnresolvedVariable:
    """The activity turns the named error into a DEGRADED step, never an activity crash."""

    @pytest.fixture
    def harness(self, monkeypatch: pytest.MonkeyPatch):
        async def _noop(*_args: Any, **_kwargs: Any) -> None:
            return None

        monkeypatch.setattr(core, "record_and_flush", _noop)
        monkeypatch.setattr(core, "_phi_redactor", lambda: None)

        def _install(answer: dict[str, Any]) -> list[dict[str, Any]]:
            calls: list[dict[str, Any]] = []

            class _Api:
                async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
                    return answer

                async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
                    return {"phiEnabled": False, "phiFailClosed": True}

            class _Text:
                async def generate(self, **kwargs: Any) -> Any:
                    calls.append(kwargs)
                    raise AssertionError("TEXT must not be called with an unresolved prompt")

            monkeypatch.setattr(core, "_api_client", lambda _settings: _Api())
            monkeypatch.setattr(core, "_text_client", lambda _settings: _Text())
            return calls

        return _install

    @pytest.mark.asyncio
    async def test_an_unresolved_prompt_variable_degrades_the_step(self, harness) -> None:
        wire = _resolved("{{trigger.absent}}").model_dump(by_alias=True)
        calls = harness(wire)

        result = await core.interpreter_core_agent(
            NodeActivityInput(
                node_id="agent1",
                node_type="core.agent",
                tenant_id=_TENANT,
                run_id=_RUN,
                config={"agentRef": {"slug": "discharge-writer"}},
                bound_inputs={"in": "the transcript"},
                run_context=_run_context(),
            )
        )

        assert result.status == "DEGRADED"
        assert "prompt_variable_unresolved" in (result.reason or "")
        assert "trigger.absent" in (result.reason or "")
        # Nothing was generated on a half-substituted prompt.
        assert calls == []
