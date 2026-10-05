"""The governed finalizer's NotePlan calls walk the agent's same-model fallback chain.

``core.agent`` (cadence ``onEnd``) executes the handoff's NotePlan. Each plan call runs on the
PLAN's model first; when that candidate loses with a ``TextServiceError``, the resolve answer's
``textFallback`` candidates that serve the SAME model are tried in chain order (a candidate on
another model never is — the plan was budgeted for one context window). The output names the
candidate that served, and a run speaking protocol v2 reports ``prompt.composed`` once and one
``model.request`` per candidate tried.

Hermetic: gateway, Text and the run-event producer are stubbed; the activity runs under
``ActivityEnvironment``.
"""

from __future__ import annotations

from typing import Any

from harness.services.note_plan.models import NotePlanV1
from harness.services.text_client import TextGenerationResult, TextServiceError
from harness.temporal.models import TrajectoryContext
from harness.tests.unit.note_plan.test_executor_task1045 import (
    _GOV_CONSULTATION,
    _GOV_TENANT,
    GROUPS,
    _answer,
    _Api,
    _CapTraj,
    _env,
    _governed_agent,
    _raw,
    activities,
)

_SAME_MODEL = {
    "kind": "agent-model",
    "agent": {"slug": "casenote-finalization", "versionNumber": 3},
    "modelSlug": "gemma-4-e2b",
    "provider": "vllm",
    "model": "google/gemma-4-e2b",
    "fundingTier": "platform",
    "deploymentKind": "SELF_HOSTED",
    "providerOverride": {"baseUrl": "http://vllm:8000/v1"},
}
_OTHER_MODEL = {
    "kind": "platform-default",
    "agent": {"slug": "platform-writer", "versionNumber": 1},
    "modelSlug": "qwen-3-8b",
    "provider": "lm-studio",
    "model": "qwen3-8b",
    "fundingTier": "platform",
}


class _Text:
    """Every call on ``down`` providers raises; every other call answers its sections."""

    def __init__(self, plan: NotePlanV1, *, down: set[str]) -> None:
        self.plan = plan
        self.down = down
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.calls.append(kwargs)
        if kwargs["provider"] in self.down:
            raise TextServiceError("down")
        call = next(c for c in self.plan.calls if kwargs["prompt"].endswith(c.directive))
        return TextGenerationResult(
            content=_answer(list(call.section_keys)),
            model=kwargs["model"],
            provider=kwargs["provider"],
            usage={"prompt_tokens": 100, "completion_tokens": 20},
            stats={"provider": kwargs["provider"], "model": kwargs["model"]},
        )


class _Producer:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def append(self, **kwargs: Any) -> None:
        self.events.append(kwargs)

    async def text_delta(self, **kwargs: Any) -> None:
        self.events.append({"type": "output.text.delta", **kwargs})


async def _run(monkeypatch, *, chain: list[dict[str, Any]], down: set[str], protocol: int | None):
    import harness.temporal.interpreter.activities as interpreter_activities
    from harness.temporal.interpreter.models import NodeActivityInput
    from harness.temporal.interpreter.nodes import core

    raw = _raw(GROUPS)
    raw["tenantId"] = _GOV_TENANT
    raw["consultationId"] = _GOV_CONSULTATION
    plan = NotePlanV1.model_validate(raw)
    agent = _governed_agent()
    agent["textFallback"] = {"autoSwitch": True, "chain": chain}

    class _GovApi(_Api):
        async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
            return agent

    api, cap, text, producer = _GovApi(raw), _CapTraj(), _Text(plan, down=down), _Producer()
    persisted: list[Any] = []

    async def _persist_draft(payload: Any) -> Any:
        from harness.services.api_client import DraftResponse

        persisted.append(payload)
        return DraftResponse(context_item_id="ctx-1", version_number=7)

    monkeypatch.setattr(core, "_api_client", lambda _s: api)
    monkeypatch.setattr(core, "_text_client", lambda _s: text)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: cap)
    monkeypatch.setattr(activities, "persist_draft", _persist_draft)
    monkeypatch.setattr(interpreter_activities, "run_event_producer", lambda: producer)

    ref = {"consultationId": _GOV_CONSULTATION, "mode": "final", "planId": raw["planId"]}
    result = await _env().run(
        core.interpreter_core_agent,
        NodeActivityInput(
            node_id="n_finalize",
            node_type="core.agent",
            config={
                "agentRef": {"slug": "casenote-finalization"},
                "execution": {"lane": "durable", "cadence": "onEnd"},
            },
            tenant_id=_GOV_TENANT,
            bound_inputs={"in": [{"text": "", "note_plan_ref": ref}]},
            run_payload={"consultationId": _GOV_CONSULTATION, "userId": "doctor-1"},
            run_context={"trigger": {"consultationId": _GOV_CONSULTATION}, "vars": {}, "nodes": {}},
            run_id="run-1",
            protocol=protocol,
            trajectory=TrajectoryContext(
                tenant_id=_GOV_TENANT, consultation_id=_GOV_CONSULTATION, seq=48
            ),
        ),
    )
    return result, text, producer, cap, persisted


async def test_a_lost_plan_call_switches_to_the_same_model_candidate(monkeypatch) -> None:
    result, text, _producer, cap, persisted = await _run(
        monkeypatch, chain=[_OTHER_MODEL, _SAME_MODEL], down={"lmstudio"}, protocol=None
    )

    assert result.status == "SUCCEEDED", result.reason
    # Each of the two calls: the plan's own provider lost, the same-model candidate served.
    # The other-model candidate is never tried.
    assert sorted((c["provider"], c["model"]) for c in text.calls) == [
        ("lmstudio", "gemma-4-e2b-it-qat"),
        ("lmstudio", "gemma-4-e2b-it-qat"),
        ("vllm", "google/gemma-4-e2b"),
        ("vllm", "google/gemma-4-e2b"),
    ]
    served = [c for c in text.calls if c["provider"] == "vllm"]
    assert all(c["provider_override"] == _SAME_MODEL["providerOverride"] for c in served)
    assert all(c["provider_locality"] == {"vllm": "local"} for c in served)
    # The output names the candidate that served, and its funding.
    assert (result.output["provider"], result.output["model"]) == ("vllm", "google/gemma-4-e2b")
    assert result.output["fundingTier"] == "platform"
    [draft] = persisted
    assert draft.content == result.output["data"]["case_note"]
    # Each lost leg leaves a failed LLM_CALL step beside the served one.
    llm = [s for s in cap.steps if s.step_type == "LLM_CALL"]
    assert sorted(s.status for s in llm) == ["ERROR", "ERROR", "OK", "OK"]


async def test_without_a_failure_the_chain_is_never_walked(monkeypatch) -> None:
    result, text, _producer, _cap, _persisted = await _run(
        monkeypatch, chain=[_SAME_MODEL], down=set(), protocol=None
    )

    assert result.status == "SUCCEEDED", result.reason
    assert {c["provider"] for c in text.calls} == {"lmstudio"}
    assert (result.output["provider"], result.output["model"]) == (
        "lmstudio",
        "gemma-4-e2b-it-qat",
    )


async def test_every_candidate_lost_degrades_the_node(monkeypatch) -> None:
    result, text, _producer, _cap, persisted = await _run(
        monkeypatch, chain=[_SAME_MODEL], down={"lmstudio", "vllm"}, protocol=None
    )

    assert result.status == "DEGRADED"
    assert "note plan call(s) failed" in (result.reason or "")
    assert len(text.calls) == 4
    assert persisted == []


async def test_protocol_v2_traces_the_composition_and_each_candidate(monkeypatch) -> None:
    result, _text, producer, _cap, _persisted = await _run(
        monkeypatch, chain=[_SAME_MODEL], down={"lmstudio"}, protocol=2
    )

    assert result.status == "SUCCEEDED", result.reason
    composed = [e for e in producer.events if e.get("type") == "prompt.composed"]
    assert len(composed) == 1
    assert composed[0]["dedupe_key"].endswith("prompt:0")
    requests = {
        (e["data"]["provider"], e["data"]["model"], e["data"]["attempt"], e["data"]["fallback"])
        for e in producer.events
        if e.get("type") == "model.request"
    }
    assert requests == {
        ("lmstudio", "gemma-4-e2b-it-qat", 1, False),
        ("vllm", "google/gemma-4-e2b", 2, True),
    }
    request = next(e for e in producer.events if e.get("type") == "model.request")
    assert request["data"]["stream"] is False
    assert request["data"]["parameters"] == {"temperature": 0}


async def test_without_protocol_v2_nothing_is_traced(monkeypatch) -> None:
    _result, _text, producer, _cap, _persisted = await _run(
        monkeypatch, chain=[_SAME_MODEL], down={"lmstudio"}, protocol=None
    )

    assert not [e for e in producer.events if e.get("type") in ("prompt.composed", "model.request")]
