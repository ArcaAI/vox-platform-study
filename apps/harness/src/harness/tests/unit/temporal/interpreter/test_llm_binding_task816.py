"""TASK-816 Phase 1 (DD-10) — the DURABLE lane carries per-node model selection.

## What this pins

A node that declares ``config.llmBinding.modelSlug`` must send that slug to the gateway, which
resolves it tenant -> SYSTEM and fails closed. A node that declares NONE must send exactly what it
sent before this ticket — its ``taskKey`` and nothing else.

The second half is the load-bearing one. The live loop resolves its model through
``AiTaskDefault``; on 2026-08-25 an unrelated change removed a credential source and produced a
silent, total generation outage. Phase 1 ADDS a tier and removes none, so "unbound is unchanged"
is the property that keeps that class of failure from recurring, and it is asserted per call site
rather than argued.

## Why the slug is threaded rather than resolved here

One model resolution serves both runtimes. The gateway owns the ``[tenant, SYSTEM]`` ENABLED-model
lookup, the ``azure -> azure-openai`` alias and the fail-closed refusal; an activity that resolved
slugs itself would be a second copy of all three, drifting on the first one that changed.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import agent_catalogue as agent_catalogue_mod
from harness.temporal.interpreter.nodes import consultation_realtime as realtime_mod
from harness.temporal.interpreter.nodes import guards as guards_mod
from harness.temporal.interpreter.nodes import text_generate as text_generate_mod
from harness.temporal.interpreter.nodes._llm_policy import resolve_text_selection
from harness.temporal.interpreter.nodes._shared import read_model_slug

BOUND_SLUG = "tenant-medgemma"


def _input(config: dict[str, Any], **kwargs: Any) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="n-1",
        node_type="test",
        config=config,
        tenant_id="tenant-1",
        bound_inputs=kwargs.pop("bound_inputs", None) or {},
        run_payload=kwargs.pop("run_payload", None) or {},
    )


class _RecordingApi:
    """Captures every kwarg the node hands ``get_policy``."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def get_policy(
        self, tenant_id, consultation_id=None, task_key=None, model_slug=None
    ) -> dict[str, Any]:
        self.calls.append(
            {"tenant_id": tenant_id, "task_key": task_key, "model_slug": model_slug}
        )
        return {"textProvider": "lm-studio", "textModel": "resolved-model"}


class TestReadModelSlug:
    """The reader: a malformed binding is ABSENT, never an exception."""

    def test_reads_a_well_formed_binding(self):
        assert read_model_slug({"llmBinding": {"modelSlug": BOUND_SLUG}}) == BOUND_SLUG

    @pytest.mark.parametrize(
        "config",
        [
            None,
            {},
            {"taskKey": "text.finalize"},
            {"llmBinding": None},
            {"llmBinding": "a-string"},
            {"llmBinding": {}},
            {"llmBinding": {"modelSlug": ""}},
            {"llmBinding": {"modelSlug": 7}},
            # The PROMPT binding is a different key entirely.
            {"promptTemplateId": "a-uuid", "promptVersionNumber": 2},
        ],
    )
    def test_absent_or_malformed_reads_as_none(self, config):
        assert read_model_slug(config) is None


class TestGenerateTextCarriesTheBinding:
    """``generate.text`` — and therefore ``consultation.synthesize`` and the three
    ``agent.*`` generation entries, which delegate to it verbatim."""

    @pytest.mark.asyncio
    async def test_a_bound_node_sends_its_slug(self, monkeypatch):
        api = _RecordingApi()
        monkeypatch.setattr(text_generate_mod, "_api_client", lambda s: api)

        await text_generate_mod.interpreter_text_generate(
            _input(
                {"taskKey": "text.finalize", "llmBinding": {"modelSlug": BOUND_SLUG}},
                bound_inputs={"in": "some text"},
            )
        )

        assert api.calls[0]["model_slug"] == BOUND_SLUG
        assert api.calls[0]["task_key"] == "text.finalize"

    @pytest.mark.asyncio
    async def test_an_UNBOUND_node_sends_no_slug_at_all(self, monkeypatch):
        api = _RecordingApi()
        monkeypatch.setattr(text_generate_mod, "_api_client", lambda s: api)

        await text_generate_mod.interpreter_text_generate(
            _input({"taskKey": "text.finalize"}, bound_inputs={"in": "some text"})
        )

        assert api.calls[0]["model_slug"] is None
        assert api.calls[0]["task_key"] == "text.finalize"


class TestLlmPolicyCarriesTheBinding:
    """The shared seam ``agent.important_findings`` and ``guard.groundedness`` both use."""

    @pytest.mark.asyncio
    async def test_threads_the_slug_to_the_gateway(self, monkeypatch):
        api = _RecordingApi()
        monkeypatch.setattr(
            "harness.temporal.interpreter.nodes._llm_policy._api_client", lambda s: api
        )

        judgement, error_code = await resolve_text_selection("tenant-1", "text.live", BOUND_SLUG)

        assert error_code is None
        assert judgement is not None
        assert api.calls[0]["model_slug"] == BOUND_SLUG

    @pytest.mark.asyncio
    async def test_omitting_the_slug_is_the_prior_call_exactly(self, monkeypatch):
        api = _RecordingApi()
        monkeypatch.setattr(
            "harness.temporal.interpreter.nodes._llm_policy._api_client", lambda s: api
        )

        await resolve_text_selection("tenant-1", "text.live")

        assert api.calls[0]["model_slug"] is None

    @pytest.mark.asyncio
    async def test_an_invalid_task_key_is_still_rejected_before_any_round_trip(
        self, monkeypatch
    ):
        api = _RecordingApi()
        monkeypatch.setattr(
            "harness.temporal.interpreter.nodes._llm_policy._api_client", lambda s: api
        )

        judgement, error_code = await resolve_text_selection("t", "nope", BOUND_SLUG)

        assert judgement is None
        assert error_code == "invalid_task_key"
        assert api.calls == []


class TestEveryModelResolvingNodeReadsTheSameKey:
    """The four modules that resolve a text selection all read the binding off ``config``.

    A grep-shaped assertion on purpose: the failure this guards against is a NEW generation node
    threading its ``taskKey`` and forgetting its binding, which would look like the node silently
    ignoring an admin's explicit model choice.
    """

    @pytest.mark.parametrize(
        "module",
        [text_generate_mod, realtime_mod, guards_mod, agent_catalogue_mod],
    )
    def test_module_reads_the_binding(self, module):
        source = __import__("inspect").getsource(module)
        assert "read_model_slug(" in source, f"{module.__name__} resolves a model but ignores llmBinding"
