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


class TestCoreAgentBindingForm:
    """§3.3 — `instruction.variables` is a map of BINDINGS, and all four renderers resolve it.

    Wave-2b close: three of the four (this lane, the realtime lane, the invocation route) passed
    the raw map through, so a `{ "value": "formal" }` binding rendered `{"value":"formal"}` while
    the draft bench — the only site that resolved bindings — rendered `formal`. An author who
    tests a prompt on the bench must not get different bytes in production.
    """

    def test_a_value_binding_renders_its_literal(self) -> None:
        prompt = core._system_prompt(
            _resolved("Tone: {{tone}}", {"tone": {"value": "formal"}}), {}, _run_context()
        )

        assert prompt == "Tone: formal"

    def test_a_path_binding_resolves_from_the_roots(self) -> None:
        prompt = core._system_prompt(
            _resolved(
                "Age {{age}} / {{context.patientAge}}", {"age": {"path": "context.patientAge"}}
            ),
            {},
            _run_context(),
        )

        assert prompt == "Age 41 / 41"

    def test_a_node_override_is_a_plain_value_and_still_wins(self) -> None:
        prompt = core._system_prompt(
            _resolved("Tone: {{tone}}", {"tone": {"value": "formal"}}),
            {"overrides": {"promptVariables": {"tone": "terse"}}},
            _run_context(),
        )

        assert prompt == "Tone: terse"

    def test_the_resolved_map_is_what_variables_star_exposes(self) -> None:
        prompt = core._system_prompt(
            _resolved("{{variables.tone}}", {"tone": {"value": "formal"}}), {}, _run_context()
        )

        assert prompt == "formal"

    def test_an_unresolvable_path_binding_raises_naming_the_path(self) -> None:
        with pytest.raises(PromptVariableUnresolved) as excinfo:
            core._system_prompt(
                _resolved("{{age}}", {"age": {"path": "context.absent"}}), {}, _run_context()
            )

        assert excinfo.value.path == "context.absent"


class TestCoreAgentGuardrailDecision:
    """§3.14 (OD-R) — the durable producer folds the opt-out and pushes it to TEXT.

    Two of the three levels are in scope on this lane. The workflow default
    (`policyBindings.guardrail`) is not: `workflow.py` does not thread it into
    `NodeActivityInput`, so a workflow-level opt-out is honoured on the realtime lane and
    inherited-as-ON here. That divergence is RECORDED (README §8/§9), not papered over with a
    second read — which is why these cases pin node > agent > ON and nothing else.
    """

    @pytest.fixture
    def captured(self, monkeypatch: pytest.MonkeyPatch):
        async def _noop(*_args: Any, **_kwargs: Any) -> None:
            return None

        monkeypatch.setattr(core, "record_and_flush", _noop)
        monkeypatch.setattr(core, "_phi_redactor", lambda: None)

        def _install(wire: dict[str, Any]) -> list[dict[str, Any]]:
            calls: list[dict[str, Any]] = []

            class _Api:
                async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
                    return wire

                async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
                    return {"phiEnabled": False, "phiFailClosed": True}

            class _Result:
                content = "the note"
                provider = "openai"
                model = "gpt-x"
                usage = {}

            class _Text:
                async def generate(self, **kwargs: Any) -> Any:
                    calls.append(kwargs)
                    return _Result()

            monkeypatch.setattr(core, "_api_client", lambda _settings: _Api())
            monkeypatch.setattr(core, "_text_client", lambda _settings: _Text())
            return calls

        return _install

    async def _run(self, captured, node_config: dict[str, Any], agent_guardrail: Any = None):
        wire = _resolved("Write the note.").model_dump(by_alias=True)
        if agent_guardrail is not None:
            wire["compiledConfig"]["guardrail"] = {"enabled": agent_guardrail}
        calls = captured(wire)
        result = await core.interpreter_core_agent(
            NodeActivityInput(
                node_id="agent1",
                node_type="core.agent",
                tenant_id=_TENANT,
                run_id=_RUN,
                config={"agentRef": {"slug": "discharge-writer"}, **node_config},
                bound_inputs={"in": "the transcript"},
                run_context=_run_context(),
            )
        )
        return result, calls

    @pytest.mark.asyncio
    async def test_screens_by_default_and_says_so_explicitly(self, captured) -> None:
        result, calls = await self._run(captured, {})

        assert calls[0]["guardrail_policy"] == {"enabled": True}
        assert result.output["guardrail"] == {"enabled": True, "source": "default"}

    @pytest.mark.asyncio
    async def test_honours_the_node_opt_out(self, captured) -> None:
        result, calls = await self._run(captured, {"guardrail": {"enabled": False}})

        assert calls[0]["guardrail_policy"] == {"enabled": False}
        assert result.output["guardrail"] == {"enabled": False, "source": "node"}

    @pytest.mark.asyncio
    async def test_falls_through_to_the_agent_opinion(self, captured) -> None:
        result, calls = await self._run(captured, {}, agent_guardrail=False)

        assert calls[0]["guardrail_policy"] == {"enabled": False}
        assert result.output["guardrail"] == {"enabled": False, "source": "agent"}

    @pytest.mark.asyncio
    async def test_the_node_overrides_the_agent_in_the_on_direction(self, captured) -> None:
        _result, calls = await self._run(
            captured, {"guardrail": {"enabled": True}}, agent_guardrail=False
        )

        assert calls[0]["guardrail_policy"] == {"enabled": True}

    @pytest.mark.asyncio
    async def test_a_malformed_agent_opinion_reads_as_screened(self, captured) -> None:
        """On a safety gate, "unparseable" must never resolve to an opt-out."""
        _result, calls = await self._run(captured, {}, agent_guardrail="false")

        assert calls[0]["guardrail_policy"] == {"enabled": True}


class TestSingleKindContextEnvelope:
    """J3-5 — one kind keyed ``context`` is not an envelope, on the durable lane either.

    ``payloadSchemaFromDefinition`` keys a declaration's payload under each KIND, so the seeded
    bridge schema ``consultation_legacy_v1`` — a single kind whose key is ``context`` — produces
    ``{"context": {"safe_age": …}}``. On a workflow run that IS the validated trigger, and the
    ``context`` alias binds it whole, so the seeded ``{{context.safe_age}}`` resolved to nothing
    and the only spelling that could work was ``{{context.context.safe_age}}``.

    The gateway unwraps it (``unwrapSingleKindContextPayload``,
    ``packages/applications/src/services/consultation-context-schema/context-schema-definition.ts``)
    and this is the hand-written mirror. It must stay a mirror: an agent whose prompt renders one
    way on ``POST /agents/:slug/invocations`` and another way inside a Temporal run is the exact
    failure the ONE-scope rule of §3.3 exists to prevent.
    """

    _LEGACY_SCHEMA = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "context": {
                "type": "object",
                "properties": {"safe_age": {"type": "string"}},
            }
        },
    }

    _MULTI_SCHEMA = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "context": {"type": "object", "properties": {"safe_age": {"type": "string"}}},
            "audio": {"type": "object"},
        },
    }

    @staticmethod
    def _bound(prompt: str, payload_schema: dict[str, Any]) -> ResolvedAgent:
        resolved = _resolved(prompt)
        assert resolved.compiled_config is not None
        resolved.compiled_config["contextSchema"] = {
            "schemaId": "schema-legacy",
            "versionNumber": 1,
            "versionId": "schema-legacy-v1",
            "payloadSchema": payload_schema,
        }
        return resolved

    def test_the_alias_unwraps_the_sole_context_kind(self) -> None:
        context = {"trigger": {"context": {"safe_age": "41"}}, "vars": {}, "nodes": {}}

        prompt = core._system_prompt(
            self._bound("Age {{context.safe_age}}.", self._LEGACY_SCHEMA), {}, context
        )

        assert prompt == "Age 41."

    def test_trigger_keeps_the_envelope_verbatim(self) -> None:
        """``trigger`` IS the run payload; only the ``context`` alias is the unwrapped view."""
        context = {"trigger": {"context": {"safe_age": "41"}}, "vars": {}, "nodes": {}}

        prompt = core._system_prompt(
            self._bound("Age {{trigger.context.safe_age}}.", self._LEGACY_SCHEMA), {}, context
        )

        assert prompt == "Age 41."

    def test_a_flat_payload_is_left_alone(self) -> None:
        """A run whose trigger already carries the flat kind object needs no unwrap."""
        context = {"trigger": {"safe_age": "41"}, "vars": {}, "nodes": {}}

        prompt = core._system_prompt(
            self._bound("Age {{context.safe_age}}.", self._LEGACY_SCHEMA), {}, context
        )

        assert prompt == "Age 41."

    def test_a_multi_kind_envelope_stays_verbatim(self) -> None:
        context = {
            "trigger": {"context": {"safe_age": "41"}, "audio": {"uri": "s3://x"}},
            "vars": {},
            "nodes": {},
        }

        prompt = core._system_prompt(
            self._bound("Age {{context.context.safe_age}}.", self._MULTI_SCHEMA), {}, context
        )

        assert prompt == "Age 41."

    def test_an_unbound_agent_keeps_the_plain_alias(self) -> None:
        """No bound schema, no rule to apply — the §3.3 alias is unchanged."""
        context = {"trigger": {"patientAge": 41}, "vars": {}, "nodes": {}}

        prompt = core._system_prompt(_resolved("Age {{context.patientAge}}."), {}, context)

        assert prompt == "Age 41."
