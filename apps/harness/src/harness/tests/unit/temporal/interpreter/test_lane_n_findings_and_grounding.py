"""Lane N  — important findings, and grounding as tenant-authored policy.

audit of the realtime loop found the owner's third acceptance item simply missing:
*"important information highlighted — DOES NOT EXIST ... there is no red-flag / critical-value /
allergy-alert / severity layer anywhere"*. The owner's answer to "what makes it important?" was
not a layer, it was a configuration contract — findings are extracted *"following a set of
instructions defined/declared/overwriten by tenant admin"*, and grounding evaluates the redacted
transcript, the redacted summary and those findings against *"a set of policies"* authored the
same way.

So what is specified here is not an algorithm. It is that **nothing in the interpreter decides**:
the instruction comes from an APPROVED template or the node degrades, the model's own answer
passes through unre-scored, and a policy that could not run is reported UNEVALUATED rather than
quietly reading as satisfied. The adapter contract every other consultation node carries applies
too — identity from ``run_payload``, data from ``bound_inputs``, CR-14's degrade-never-raise, and
selection that fails CLOSED.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.services.api_client import ApiServiceError, ResolvedPromptTemplateResponse
from harness.services.text_client import TextGenerationResult, TextServiceError
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import _llm_policy as llm
from harness.temporal.interpreter.nodes import agent_catalogue as cat
from harness.temporal.interpreter.nodes import guards as gd

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = {"consultationId": "c1", "externalPatientId": "p1", "userId": "u1"}
_TEMPLATE = "11111111-1111-1111-1111-111111111111"


def _payload(node_type: str, **overrides) -> NodeActivityInput:
    base: dict[str, Any] = {
        "node_id": "n1",
        "node_type": node_type,
        "config": {},
        "tenant_id": _TENANT,
        "sandbox": False,
        "bound_inputs": {},
        "run_payload": dict(_RUN),
    }
    base.update(overrides)
    return NodeActivityInput(**base)


class _FakeApi:
    """Resolves a selection and a prompt template; records what was asked for."""

    def __init__(self, *, provider="lm-studio", model="a-model", found=True, approved=True, content="TENANT INSTRUCTION"):
        self.provider = provider
        self.model = model
        self.found = found
        self.approved = approved
        self.content = content
        self.resolved_ids: list[str] = []
        self.policy_task_keys: list[Any] = []

    async def get_policy(self, tenant_id, consultation_id=None, task_key=None, model_slug=None):
        self.policy_task_keys.append(task_key)
        return {
            "textProvider": self.provider,
            "textModel": self.model,
            "phiEnabled": False,
            "phiFailClosed": True,
        }

    async def get_resolved_prompt_template(self, template_id, tenant_id=None):
        self.resolved_ids.append(template_id)
        return ResolvedPromptTemplateResponse(
            found=self.found, approved=self.approved, content=self.content, version_number=1
        )


class _FakeText:
    def __init__(self, *contents: str):
        self._contents = list(contents)
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs):
        self.calls.append(kwargs)
        content = self._contents[min(len(self.calls) - 1, len(self._contents) - 1)]
        return TextGenerationResult(content=content, provider="lm-studio", model="a-model")


class _FailingText:
    async def generate(self, **kwargs):
        raise TextServiceError("text is down")


@pytest.fixture(autouse=True)
def _no_record(monkeypatch):
    """`record_and_flush` writes a trajectory step over the API; irrelevant here and noisy."""

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(cat, "record_and_flush", _noop)
    monkeypatch.setattr("harness.temporal.interpreter.nodes.guards.interpreter_consultation_sensors", _sensors_ok)


async def _sensors_ok(payload):  # noqa: ANN001
    from harness.temporal.interpreter.models import NodeActivityResult

    return NodeActivityResult(status="SUCCEEDED", output={"text": "the note", "verdict": {"scores": {}}})


# ---------------------------------------------------------------------------
# agent.important_findings
# ---------------------------------------------------------------------------


class TestImportantFindings:
    @pytest.mark.asyncio
    async def test_extracts_findings_using_the_tenants_own_instruction(self, monkeypatch):
        """The instruction is the tenant's template content — verbatim, as the system prompt."""
        api = _FakeApi(content="Pick out what THIS tenant considers important.")
        text = _FakeText('{"findings":[{"text":"penicillin allergy","type":"allergy"}]}')
        monkeypatch.setattr(llm, "_api_client", lambda s: api)
        monkeypatch.setattr(llm, "_text_client", lambda s: text)

        result = await cat.interpreter_agent_important_findings(
            _payload(
                "agent.important_findings",
                config={"promptTemplateId": _TEMPLATE, "onError": "degrade"},
                bound_inputs={"in": "patient reports a penicillin allergy"},
            )
        )

        assert result.status == "SUCCEEDED"
        assert result.output["findings"] == [{"text": "penicillin allergy", "type": "allergy"}]
        assert api.resolved_ids == [_TEMPLATE]
        assert text.calls[0]["system_prompt"] == "Pick out what THIS tenant considers important."

    @pytest.mark.asyncio
    async def test_an_unbound_instruction_DEGRADES_and_never_falls_back_to_a_default(self, monkeypatch):
        """The load-bearing test of this whole capability.

        A default instruction here would be the platform deciding what is clinically important for
        every tenant — the hardcoded configuration the owner's specification exists to prevent. So
        an unbound template must stop the node, visibly, and must never reach a model.
        """
        api = _FakeApi()
        monkeypatch.setattr(llm, "_api_client", lambda s: api)
        monkeypatch.setattr(
            llm, "_text_client", lambda s: pytest.fail("must not generate without a tenant instruction")
        )

        result = await cat.interpreter_agent_important_findings(
            _payload("agent.important_findings", bound_inputs={"in": "something was said"})
        )
        assert result.status == "DEGRADED"
        assert "no instruction template is bound" in result.reason

    @pytest.mark.asyncio
    async def test_an_unapproved_instruction_DEGRADES(self, monkeypatch):
        api = _FakeApi(approved=False)
        monkeypatch.setattr(llm, "_api_client", lambda s: api)
        monkeypatch.setattr(llm, "_text_client", lambda s: pytest.fail("must not generate on an unapproved prompt"))

        result = await cat.interpreter_agent_important_findings(
            _payload(
                "agent.important_findings",
                config={"promptTemplateId": _TEMPLATE},
                bound_inputs={"in": "something was said"},
            )
        )
        assert result.status == "DEGRADED"
        assert "no approved version" in result.reason

    @pytest.mark.asyncio
    async def test_selection_fails_CLOSED(self, monkeypatch):
        api = _FakeApi(provider="", model="")
        monkeypatch.setattr(llm, "_api_client", lambda s: api)
        monkeypatch.setattr(llm, "_text_client", lambda s: pytest.fail("must not generate without a selection"))

        result = await cat.interpreter_agent_important_findings(
            _payload(
                "agent.important_findings",
                config={"promptTemplateId": _TEMPLATE},
                bound_inputs={"in": "something was said"},
            )
        )
        assert result.status == "DEGRADED"
        assert "no text provider/model resolved" in result.reason

    @pytest.mark.asyncio
    async def test_no_bound_transcript_degrades_before_any_call(self, monkeypatch):
        monkeypatch.setattr(llm, "_api_client", lambda s: pytest.fail("must not resolve anything"))
        result = await cat.interpreter_agent_important_findings(_payload("agent.important_findings"))
        assert result.status == "DEGRADED"
        assert "no transcript bound" in result.reason

    @pytest.mark.asyncio
    async def test_keeps_the_tenants_own_label_and_invents_none(self, monkeypatch):
        """No taxonomy is applied. A row with no label is DROPPED, never defaulted — supplying one
        would answer the question the owner assigned to the tenant admin."""
        api = _FakeApi()
        text = _FakeText(
            '{"findings":[{"text":"a","type":"whatever-the-tenant-called-it"},{"text":"b"},{"type":"x"}]}'
        )
        monkeypatch.setattr(llm, "_api_client", lambda s: api)
        monkeypatch.setattr(llm, "_text_client", lambda s: text)

        result = await cat.interpreter_agent_important_findings(
            _payload(
                "agent.important_findings",
                config={"promptTemplateId": _TEMPLATE},
                bound_inputs={"in": "said"},
            )
        )
        assert result.output["findings"] == [{"text": "a", "type": "whatever-the-tenant-called-it"}]

    @pytest.mark.asyncio
    async def test_an_unparseable_reply_degrades_rather_than_fabricating(self, monkeypatch):
        monkeypatch.setattr(llm, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(llm, "_text_client", lambda s: _FakeText("I could not find anything, sorry!"))

        result = await cat.interpreter_agent_important_findings(
            _payload(
                "agent.important_findings",
                config={"promptTemplateId": _TEMPLATE},
                bound_inputs={"in": "said"},
            )
        )
        assert result.status == "DEGRADED"
        assert "parseable" in result.reason

    @pytest.mark.asyncio
    async def test_a_text_outage_degrades_and_never_raises(self, monkeypatch):
        monkeypatch.setattr(llm, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(llm, "_text_client", lambda s: _FailingText())

        result = await cat.interpreter_agent_important_findings(
            _payload(
                "agent.important_findings",
                config={"promptTemplateId": _TEMPLATE},
                bound_inputs={"in": "said"},
            )
        )
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_context_items_travel_alongside_the_transcript(self, monkeypatch):
        """"...from consultation context (transcription, consultation context items, etc...)"."""
        api = _FakeApi()
        text = _FakeText('{"findings":[]}')
        monkeypatch.setattr(llm, "_api_client", lambda s: api)
        monkeypatch.setattr(llm, "_text_client", lambda s: text)

        await cat.interpreter_agent_important_findings(
            _payload(
                "agent.important_findings",
                config={"promptTemplateId": _TEMPLATE},
                bound_inputs={"in": "said", "context": [{"kind": "CASE_NOTE"}]},
            )
        )
        assert '"context"' in text.calls[0]["prompt"]

    @pytest.mark.asyncio
    async def test_max_findings_bounds_the_output(self, monkeypatch):
        monkeypatch.setattr(llm, "_api_client", lambda s: _FakeApi())
        many = ",".join(f'{{"text":"f{i}","type":"t"}}' for i in range(10))
        monkeypatch.setattr(llm, "_text_client", lambda s: _FakeText('{"findings":[' + many + "]}"))

        result = await cat.interpreter_agent_important_findings(
            _payload(
                "agent.important_findings",
                config={"promptTemplateId": _TEMPLATE, "maxFindings": 3},
                bound_inputs={"in": "said"},
            )
        )
        assert len(result.output["findings"]) == 3


# ---------------------------------------------------------------------------
# guard.groundedness — the policy set
# ---------------------------------------------------------------------------


def _policy(key="p1", applies_to="summary", template=_TEMPLATE, **extra):
    return {"key": key, "appliesTo": applies_to, "promptTemplateId": template, **extra}


class TestGroundingPolicies:
    @pytest.mark.asyncio
    async def test_no_policies_means_UNCHANGED_behaviour(self, monkeypatch):
        """Every graph published before this ticket declares none, and must be untouched."""
        monkeypatch.setattr(llm, "_api_client", lambda s: pytest.fail("must not resolve a policy"))
        result = await gd.interpreter_guard_groundedness(
            _payload("guard.groundedness", bound_inputs={"in": {"text": "the note"}})
        )
        assert result.status == "SUCCEEDED"
        assert "policyVerdicts" not in (result.output or {})

    @pytest.mark.asyncio
    async def test_evaluates_each_declared_policy_against_the_input_it_is_scoped_to(self, monkeypatch):
        api = _FakeApi(content="THE TENANT'S GROUNDING RUBRIC")
        text = _FakeText('{"ok":true,"notes":"looks grounded"}')
        monkeypatch.setattr(llm, "_api_client", lambda s: api)
        monkeypatch.setattr(llm, "_text_client", lambda s: text)

        result = await gd.interpreter_guard_groundedness(
            _payload(
                "guard.groundedness",
                config={"policies": [_policy("summary-check", "summary"), _policy("transcript-check", "transcript")]},
                bound_inputs={"in": {"text": "the note"}, "transcript": "what was said"},
            )
        )

        verdicts = result.output["policyVerdicts"]
        assert [v["key"] for v in verdicts] == ["summary-check", "transcript-check"]
        assert all(v["status"] == "EVALUATED" for v in verdicts)
        # The verdict SHAPE is the tenant's — nothing here re-scores or re-labels the model's answer.
        assert verdicts[0]["result"] == {"ok": True, "notes": "looks grounded"}
        assert text.calls[0]["system_prompt"] == "THE TENANT'S GROUNDING RUBRIC"

    @pytest.mark.asyncio
    async def test_a_policy_whose_input_is_UNWIRED_is_reported_never_silently_skipped(self, monkeypatch):
        """A tenant that declared a findings policy and wired no findings has a graph problem. An
        empty verdict list would hide it; an "EVALUATED" one would be a lie."""
        monkeypatch.setattr(llm, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(llm, "_text_client", lambda s: _FakeText("{}"))

        result = await gd.interpreter_guard_groundedness(
            _payload(
                "guard.groundedness",
                config={"policies": [_policy("findings-check", "findings")]},
                bound_inputs={"in": {"text": "the note"}},
            )
        )
        assert result.status == "DEGRADED"
        assert result.output["policyVerdicts"][0]["status"] == "UNEVALUATED"
        assert result.output["policyVerdicts"][0]["errorCode"] == "policy_input_unbound"

    @pytest.mark.asyncio
    async def test_an_unresolvable_policy_instruction_is_UNEVALUATED_never_passed(self, monkeypatch):
        monkeypatch.setattr(llm, "_api_client", lambda s: _FakeApi(approved=False))
        monkeypatch.setattr(llm, "_text_client", lambda s: pytest.fail("must not evaluate an unapproved policy"))

        result = await gd.interpreter_guard_groundedness(
            _payload(
                "guard.groundedness",
                config={"policies": [_policy()]},
                bound_inputs={"in": {"text": "the note"}},
            )
        )
        assert result.status == "DEGRADED"
        assert result.output["policyVerdicts"][0]["status"] == "UNEVALUATED"

    @pytest.mark.asyncio
    async def test_selection_failure_leaves_every_policy_UNEVALUATED(self, monkeypatch):
        monkeypatch.setattr(llm, "_api_client", lambda s: _FakeApi(provider="", model=""))
        monkeypatch.setattr(llm, "_text_client", lambda s: pytest.fail("must not evaluate without a selection"))

        result = await gd.interpreter_guard_groundedness(
            _payload(
                "guard.groundedness",
                config={"policies": [_policy("a"), _policy("b")]},
                bound_inputs={"in": {"text": "the note"}},
            )
        )
        assert result.status == "DEGRADED"
        assert [v["status"] for v in result.output["policyVerdicts"]] == ["UNEVALUATED", "UNEVALUATED"]

    @pytest.mark.asyncio
    async def test_a_disabled_policy_is_not_evaluated(self, monkeypatch):
        monkeypatch.setattr(llm, "_api_client", lambda s: pytest.fail("must not resolve a disabled policy"))
        result = await gd.interpreter_guard_groundedness(
            _payload(
                "guard.groundedness",
                config={"policies": [_policy(enabled=False)]},
                bound_inputs={"in": {"text": "the note"}},
            )
        )
        # No enabled policy left ⇒ the pre-existing pass, unchanged.
        assert result.status == "SUCCEEDED"
        assert "policyVerdicts" not in (result.output or {})

    @pytest.mark.asyncio
    async def test_absent_enabled_means_ENABLED(self, monkeypatch):
        monkeypatch.setattr(llm, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(llm, "_text_client", lambda s: _FakeText("{}"))
        result = await gd.interpreter_guard_groundedness(
            _payload(
                "guard.groundedness",
                config={"policies": [_policy()]},
                bound_inputs={"in": {"text": "the note"}},
            )
        )
        assert result.output["policyVerdicts"][0]["status"] == "EVALUATED"

    def test_the_target_set_mirrors_the_typescript_contract(self):
        """`GROUNDING_POLICY_TARGETS` is authored on BOTH sides — TS validates an author, Python
        dispatches. The two agreeing is the whole reason the enum can be trusted."""
        assert gd.GROUNDING_POLICY_TARGETS == ("transcript", "summary", "findings")
        assert set(gd._TARGET_PORT) == set(gd.GROUNDING_POLICY_TARGETS)


class TestInstructionResolution:
    @pytest.mark.asyncio
    async def test_a_gateway_outage_is_distinguishable_from_an_unbound_prompt(self, monkeypatch):
        class _Down:
            async def get_resolved_prompt_template(self, template_id, tenant_id=None):
                raise ApiServiceError("gateway down")

        monkeypatch.setattr(llm, "_api_client", lambda s: _Down())
        with pytest.raises(llm.InstructionUnavailable) as excinfo:
            await llm.resolve_instruction(_TEMPLATE, _TENANT, missing_code="no_x_bound")
        assert excinfo.value.error_code == "instruction_resolution_unreachable"
