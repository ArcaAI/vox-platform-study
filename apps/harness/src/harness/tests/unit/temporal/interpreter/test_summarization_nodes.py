"""RED-first tests for the summarization palette's five node activities (TASK-720 Task 4/5).

Each activity is called directly (mirrors ``test_config_loader.py``'s calling convention for
``interpreter.load_config`` — no ``ActivityEnvironment`` wrapper needed since none of these
activities read ``temporalio.activity.info()``). External clients (``ApiClient``, ``SmrClient``,
``GuardrailClient``, the claim-check blob store) are monkeypatched at the name each node module
imported them under (Python binds a local name at import time, so the patch target is the NODE
module, never the origin module).
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.services.api_client import ApiServiceError, ResolvedPromptTemplateResponse
from harness.services.guardrail_client import GuardrailAnalysis, GuardrailServiceError
from harness.services.smr_client import SmrGenerationResult, SmrServiceError
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import context_binding as context_binding_mod
from harness.temporal.interpreter.nodes import deliver as deliver_mod
from harness.temporal.interpreter.nodes import guardrail_check as guardrail_check_mod
from harness.temporal.interpreter.nodes import template_ref as template_ref_mod
from harness.temporal.interpreter.nodes import text_generate as text_generate_mod
from harness.temporal.models import HarnessPolicy


def _input(
    config: dict[str, Any],
    *,
    bound_inputs: dict[str, Any] | None = None,
    run_payload: dict[str, Any] | None = None,
) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="n-1",
        node_type="test",
        config=config,
        tenant_id="tenant-1",
        bound_inputs=bound_inputs or {},
        run_payload=run_payload or {},
    )


# ---------------------------------------------------------------------------
# N-1 — input.context_binding
# ---------------------------------------------------------------------------


class TestContextBinding:
    _CONFIG = {
        "contextSchema": {
            "schemaVersion": "1.0",
            "kinds": [
                {
                    "key": "source_text",
                    "label": "Source text",
                    "primitive": "TEXT",
                    "phiClass": "NON_PHI",
                    "cardinality": "ONE",
                    "lifecycle": "ANY",
                    "producedBy": ["CLIENT"],
                    "required": True,
                }
            ],
        },
        "bindings": [{"kindKey": "source_text", "from": "payload.text"}],
    }

    @pytest.mark.asyncio
    async def test_binds_a_declared_kind_from_the_run_payload(self):
        payload = _input(self._CONFIG, run_payload={"text": "hello world"})
        result = await context_binding_mod.interpreter_context_binding(payload)
        assert result.status == "SUCCEEDED"
        assert result.output == {"source_text": "hello world"}

    @pytest.mark.asyncio
    async def test_rejects_a_payload_violating_the_declared_shape_missing(self):
        payload = _input(self._CONFIG, run_payload={})
        result = await context_binding_mod.interpreter_context_binding(payload)
        assert result.status == "DEGRADED"
        assert "source_text" in (result.reason or "")

    @pytest.mark.asyncio
    async def test_rejects_a_payload_violating_the_declared_shape_wrong_type(self):
        payload = _input(self._CONFIG, run_payload={"text": 12345})
        result = await context_binding_mod.interpreter_context_binding(payload)
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_optional_kind_missing_does_not_degrade(self):
        config = {
            "contextSchema": {
                "schemaVersion": "1.0",
                "kinds": [
                    {
                        "key": "opt",
                        "label": "Optional",
                        "primitive": "TEXT",
                        "phiClass": "NON_PHI",
                        "cardinality": "ONE",
                        "lifecycle": "ANY",
                        "producedBy": ["CLIENT"],
                        "required": False,
                    }
                ],
            },
            "bindings": [{"kindKey": "opt", "from": "payload.missing"}],
        }
        payload = _input(config, run_payload={})
        result = await context_binding_mod.interpreter_context_binding(payload)
        assert result.status == "SUCCEEDED"
        assert result.output == {}


# ---------------------------------------------------------------------------
# N-2 — prompt.template_ref
# ---------------------------------------------------------------------------


class TestTemplateRef:
    @pytest.mark.asyncio
    async def test_resolves_the_approved_version_and_substitutes_variables(self, monkeypatch):
        class _FakeApi:
            async def get_resolved_prompt_template(self, template_id, *, tenant_id):
                return ResolvedPromptTemplateResponse(
                    found=True, approved=True, content="Hello {{name}}", version_number=3
                )

        monkeypatch.setattr(template_ref_mod, "_api_client", lambda s: _FakeApi())
        payload = _input(
            {
                "promptTemplateId": "11111111-1111-1111-1111-111111111111",
                "variableBindings": {"name": "World"},
            }
        )
        result = await template_ref_mod.interpreter_template_ref(payload)
        assert result.status == "SUCCEEDED"
        assert result.output == {
            "content": "Hello World",
            "promptTemplateId": "11111111-1111-1111-1111-111111111111",
            "versionNumber": 3,
        }

    @pytest.mark.asyncio
    async def test_refuses_a_never_approved_template(self, monkeypatch):
        class _FakeApi:
            async def get_resolved_prompt_template(self, template_id, *, tenant_id):
                return ResolvedPromptTemplateResponse(found=True, approved=False)

        monkeypatch.setattr(template_ref_mod, "_api_client", lambda s: _FakeApi())
        payload = _input({"promptTemplateId": "11111111-1111-1111-1111-111111111111"})
        result = await template_ref_mod.interpreter_template_ref(payload)
        assert result.status == "DEGRADED"
        assert "approved" in (result.reason or "")

    @pytest.mark.asyncio
    async def test_refuses_a_cross_tenant_or_missing_id(self, monkeypatch):
        class _FakeApi:
            async def get_resolved_prompt_template(self, template_id, *, tenant_id):
                return ResolvedPromptTemplateResponse(found=False, approved=False)

        monkeypatch.setattr(template_ref_mod, "_api_client", lambda s: _FakeApi())
        payload = _input({"promptTemplateId": "11111111-1111-1111-1111-111111111111"})
        result = await template_ref_mod.interpreter_template_ref(payload)
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_gateway_unreachable_degrades_not_raises(self, monkeypatch):
        class _FakeApi:
            async def get_resolved_prompt_template(self, template_id, *, tenant_id):
                raise ApiServiceError("boom")

        monkeypatch.setattr(template_ref_mod, "_api_client", lambda s: _FakeApi())
        payload = _input({"promptTemplateId": "11111111-1111-1111-1111-111111111111"})
        result = await template_ref_mod.interpreter_template_ref(payload)
        assert result.status == "DEGRADED"


# ---------------------------------------------------------------------------
# N-3 — generate.text
# ---------------------------------------------------------------------------


class TestTextGenerate:
    @pytest.mark.asyncio
    async def test_posts_to_smr_with_the_resolved_provider_and_model_and_no_default(
        self, monkeypatch
    ):
        captured: dict[str, Any] = {}

        class _FakeApi:
            async def get_policy(self, tenant_id):
                return {
                    "smrProvider": "lm-studio",
                    "smrModel": "some-model",
                    "phiEnabled": False,
                    "phiFailClosed": True,
                }

        class _FakeSmr:
            async def generate(self, **kwargs):
                captured.update(kwargs)
                return SmrGenerationResult(
                    content="the summary", provider="lm-studio", model="some-model"
                )

        monkeypatch.setattr(text_generate_mod, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(text_generate_mod, "_smr_client", lambda s: _FakeSmr())
        payload = _input(
            {"taskKey": "smr.finalize"},
            bound_inputs={"in": {"source_text": "the source text"}},
        )
        result = await text_generate_mod.interpreter_text_generate(payload)
        assert result.status == "SUCCEEDED"
        assert result.output == {
            "text": "the summary",
            "provider": "lm-studio",
            "model": "some-model",
        }
        assert captured["provider"] == "lm-studio"
        assert captured["model"] == "some-model"
        assert "the source text" in captured["prompt"]

    @pytest.mark.asyncio
    async def test_no_default_model_degrades_rather_than_guessing(self, monkeypatch):
        class _FakeApi:
            async def get_policy(self, tenant_id):
                return {"smrProvider": None, "smrModel": None}

        monkeypatch.setattr(text_generate_mod, "_api_client", lambda s: _FakeApi())
        payload = _input({"taskKey": "smr.finalize"}, bound_inputs={"in": {"source_text": "x"}})
        result = await text_generate_mod.interpreter_text_generate(payload)
        assert result.status == "DEGRADED"
        assert "no smr provider/model" in (result.reason or "").lower()

    @pytest.mark.asyncio
    async def test_no_bound_text_degrades(self):
        payload = _input({"taskKey": "smr.finalize"}, bound_inputs={})
        result = await text_generate_mod.interpreter_text_generate(payload)
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_smr_failure_degrades(self, monkeypatch):
        class _FakeApi:
            async def get_policy(self, tenant_id):
                return {"smrProvider": "lm-studio", "smrModel": "m"}

        class _FailingSmr:
            async def generate(self, **kwargs):
                raise SmrServiceError("smr down")

        monkeypatch.setattr(text_generate_mod, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(text_generate_mod, "_smr_client", lambda s: _FailingSmr())
        payload = _input({"taskKey": "smr.finalize"}, bound_inputs={"in": {"source_text": "x"}})
        result = await text_generate_mod.interpreter_text_generate(payload)
        assert result.status == "DEGRADED"


# ---------------------------------------------------------------------------
# N-4 — guardrail.check
# ---------------------------------------------------------------------------


class TestGuardrailCheck:
    @pytest.mark.asyncio
    async def test_safe_verdict_succeeds(self, monkeypatch):
        class _FakeGuardrail:
            def __init__(self, *a, **kw):
                pass

            async def analyze(self, *, text, tenant_id, guardrail_type, request_id=None):
                return GuardrailAnalysis(safe=True, confidence=0.9, error=None)

        monkeypatch.setattr(guardrail_check_mod, "GuardrailClient", _FakeGuardrail)
        payload = _input(
            {"guardrailType": "content_safety", "failOn": "unsafe_or_unknown", "onFail": "mark"},
            bound_inputs={
                "in": {"text": "the generated text", "provider": "lm-studio", "model": "m"}
            },
        )
        result = await guardrail_check_mod.interpreter_guardrail_check(payload)
        assert result.status == "SUCCEEDED"
        assert result.output["verdict"] == "safe"

    @pytest.mark.asyncio
    async def test_safe_true_with_a_non_null_error_does_not_pass(self, monkeypatch):
        """The load-bearing fail-closed assertion (README §2/AC): guardrail's own fail-open
        branch (`safe=True` + a non-null `error`) must NEVER be treated as a pass."""

        class _FakeGuardrail:
            def __init__(self, *a, **kw):
                pass

            async def analyze(self, *, text, tenant_id, guardrail_type, request_id=None):
                return GuardrailAnalysis(
                    safe=True, issues=["processing_error"], confidence=0.0, error="boom"
                )

        monkeypatch.setattr(guardrail_check_mod, "GuardrailClient", _FakeGuardrail)
        payload = _input(
            {"guardrailType": "content_safety", "failOn": "unsafe_or_unknown", "onFail": "mark"},
            bound_inputs={"in": {"text": "t"}},
        )
        result = await guardrail_check_mod.interpreter_guardrail_check(payload)
        assert result.status == "DEGRADED"
        assert result.status != "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_unsafe_verdict_degrades(self, monkeypatch):
        class _FakeGuardrail:
            def __init__(self, *a, **kw):
                pass

            async def analyze(self, *, text, tenant_id, guardrail_type, request_id=None):
                return GuardrailAnalysis(safe=False, issues=["pii"], confidence=0.8, error=None)

        monkeypatch.setattr(guardrail_check_mod, "GuardrailClient", _FakeGuardrail)
        payload = _input(
            {"guardrailType": "content_safety", "failOn": "unsafe_or_unknown", "onFail": "mark"},
            bound_inputs={"in": {"text": "t"}},
        )
        result = await guardrail_check_mod.interpreter_guardrail_check(payload)
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_transport_failure_is_no_verdict_not_a_pass(self, monkeypatch):
        class _FailingGuardrail:
            def __init__(self, *a, **kw):
                pass

            async def analyze(self, *, text, tenant_id, guardrail_type, request_id=None):
                raise GuardrailServiceError("unreachable")

        monkeypatch.setattr(guardrail_check_mod, "GuardrailClient", _FailingGuardrail)
        payload = _input(
            {"guardrailType": "content_safety", "failOn": "unsafe_or_unknown", "onFail": "mark"},
            bound_inputs={"in": {"text": "t"}},
        )
        result = await guardrail_check_mod.interpreter_guardrail_check(payload)
        assert result.status == "DEGRADED"


# ---------------------------------------------------------------------------
# N-5 — output.deliver
# ---------------------------------------------------------------------------


class TestDeliver:
    @pytest.mark.asyncio
    async def test_shapes_the_declared_outputs_inline_when_small(self):
        payload = _input(
            {"outputs": [{"key": "summary", "primitive": "TEXT"}]},
            bound_inputs={"in": {"text": "the final summary", "verdict": "safe"}},
        )
        result = await deliver_mod.interpreter_deliver(payload)
        assert result.status == "SUCCEEDED"
        assert result.output == {"outputs": {"summary": "the final summary"}}

    @pytest.mark.asyncio
    async def test_offloads_to_claim_check_when_large(self, monkeypatch):
        monkeypatch.setattr(deliver_mod, "should_offload", lambda text, *, min_bytes: True)

        class _FakeRef:
            def model_dump(self):
                return {
                    "store": "memory",
                    "bucket": "b",
                    "key": "k",
                    "size": 1,
                    "sha256": "s",
                    "content_type": "text/plain",
                }

        async def _fake_store_blob(text, *, store, bucket):
            return _FakeRef()

        monkeypatch.setattr(deliver_mod, "store_blob", _fake_store_blob)
        payload = _input(
            {"outputs": [{"key": "summary", "primitive": "TEXT"}]},
            bound_inputs={"in": {"text": "a long summary"}},
        )
        result = await deliver_mod.interpreter_deliver(payload)
        assert result.status == "SUCCEEDED"
        assert "resultRef" in result.output
        assert "outputs" not in result.output

    @pytest.mark.asyncio
    async def test_no_bound_content_degrades(self):
        payload = _input({"outputs": [{"key": "summary", "primitive": "TEXT"}]}, bound_inputs={})
        result = await deliver_mod.interpreter_deliver(payload)
        assert result.status == "DEGRADED"


def test_harness_policy_from_api_reads_smr_selection():
    """Sanity check on the assumption `text_generate.py` depends on: `HarnessPolicy.from_api`
    maps the raw camelCase policy JSON's `smrProvider`/`smrModel` onto snake_case fields."""
    policy = HarnessPolicy.from_api({"smrProvider": "lm-studio", "smrModel": "m", "version": 1})
    assert policy.smr_provider == "lm-studio"
    assert policy.smr_model == "m"
