"""TASK-1035 — `core.agent` text generation under the new egress contract.

Pinned here:

1. The harness Presidio egress redactor is RETIRED from this lane: the prompt reaches `apps/text`
   verbatim even for a cloud candidate, because text now owns redaction and fails closed.
2. `provider_locality` is stamped per candidate ONLY from that candidate's deployment kind; a
   candidate without one sends no stamp (text decides, fail-closed cloud).
3. `known_phi` carries the identity the run holds (external patient id, names in the trigger).
4. OD-1: the guardrail opt-out is gone. A stored node config still carrying `guardrail.enabled:
   false` is accepted and IGNORED — the run succeeds and is screened.
5. Bug fix: every fallback candidate uses ITS OWN output schema; the primary's only when the
   candidate declares none.
6. The response `egress` object lands on the LLM_CALL stats as counts only.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.services.text_client import TextServiceError
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_SYSTEM = "00000000-0000-0000-0000-000000000000"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"

_PRIMARY_SCHEMA = {
    "type": "object",
    "properties": {"note": {"type": "string"}},
    "required": ["note"],
}
_FALLBACK_SCHEMA = {
    "type": "object",
    "properties": {"summary": {"type": "string"}},
    "required": ["summary"],
}


def _candidate(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "kind": "platform-default",
        "agent": {
            "slug": "platform-summarization",
            "versionId": "p1",
            "versionNumber": 1,
            "tenantId": _SYSTEM,
            "source": "platform-default",
        },
        "modelSlug": "lms-gemma",
        "provider": "lm-studio",
        "model": "gemma",
        "resolvedPrompt": {"source": "inline", "content": "PLATFORM"},
        "instruction": {"systemPrompt": "PLATFORM"},
        "parameters": {},
        "tools": [],
        "fundingTier": "platform",
    }
    base.update(over)
    return base


def _wire(*, chain: list[dict[str, Any]], primary_kind: str | None = "BYOK") -> dict[str, Any]:
    primary_row: dict[str, Any] = {
        "role": "primary",
        "slug": "az-gpt",
        "sourceUri": "gpt-5.4-mini",
        "provider": "azure",
        "tenantId": _TENANT,
    }
    if primary_kind is not None:
        primary_row["deploymentKind"] = primary_kind
    return {
        "agentId": "agent-1",
        "agentVersionId": "agent-1",
        "slug": "clinic-summarizer",
        "versionNumber": 3,
        "task": "TEXT_GENERATION",
        "tenantId": _TENANT,
        "source": "tenant",
        "compiledConfig": {
            "task": "TEXT_GENERATION",
            "model": {"slug": "az-gpt", "provider": "azure"},
            "fallbacks": [],
            "instruction": {"systemPrompt": "Summarise."},
            "resolvedPrompt": {"source": "inline", "content": "Summarise."},
            "parameters": {},
            "outputSchema": _PRIMARY_SCHEMA,
            # A stored AGENT-level opt-out from before OD-1 — must be ignored.
            "guardrail": {"enabled": False},
        },
        "models": [primary_row],
        "textFallback": {"autoSwitch": True, "chain": chain},
    }


def _payload(config: dict[str, Any] | None = None) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="agent1",
        node_type="core.agent",
        config=config or {"agentRef": {"slug": "clinic-summarizer"}},
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs={"in": "Ada Lovelace reports chest pain."},
        run_payload={"consultationId": "c-1", "externalPatientId": "MRN-00042"},
        run_id=_RUN,
        run_context={"trigger": {"patient": {"name": "Ada Lovelace"}}},
    )


class _Result:
    def __init__(self, provider: str, model: str, egress: dict[str, Any] | None = None) -> None:
        self.content = '{"note": "ok", "summary": "ok"}'
        self.provider = provider
        self.model = model
        self.usage = None
        self.stats = None
        self.usage_detail = None
        self.egress = egress


class _StubText:
    def __init__(self, failing: set[str], egress: dict[str, Any] | None = None) -> None:
        self.failing = failing
        self.egress = egress
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> _Result:
        self.calls.append(kwargs)
        if kwargs["provider"] in self.failing:
            raise TextServiceError(f"{kwargs['provider']} down")
        return _Result(kwargs["provider"], kwargs["model"], self.egress)


class _StubApi:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer = answer
        self.policy_calls = 0

    async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
        return self.answer

    async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        self.policy_calls += 1
        # PHI egress ON and fail-closed: under the OLD code a cloud candidate would have been
        # Presidio-redacted here. The new code must not consult it at all.
        return {"phiEnabled": True, "phiFailClosed": True}


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch):
    recorded: list[dict[str, Any]] = []

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def _record_generation(_payload: Any, **kwargs: Any) -> None:
        recorded.append(kwargs)

    monkeypatch.setattr(core, "record_and_flush", _noop)
    monkeypatch.setattr(core, "record_generation_and_flush", _record_generation)

    def _install(answer: dict[str, Any], failing: set[str], egress: dict[str, Any] | None = None):
        api = _StubApi(answer)
        text = _StubText(failing, egress)
        monkeypatch.setattr(core, "_api_client", lambda _settings: api)
        monkeypatch.setattr(core, "_text_client", lambda _settings: text)
        return text, recorded

    return _install


def test_the_presidio_egress_guard_is_not_imported_by_core() -> None:
    assert not hasattr(core, "ensure_egress_safe")
    assert not hasattr(core, "_phi_redactor")


@pytest.mark.asyncio
async def test_cloud_prompt_reaches_text_verbatim(harness) -> None:
    text, _ = harness(_wire(chain=[]), failing=set())

    result = await core.interpreter_core_agent(_payload())

    assert result.status == "SUCCEEDED"
    assert "Ada Lovelace reports chest pain." in text.calls[0]["prompt"]


@pytest.mark.asyncio
async def test_locality_is_stamped_per_candidate_from_its_deployment_kind(harness) -> None:
    chain = [
        _candidate(deploymentKind="SELF_HOSTED"),
        _candidate(provider="bedrock", model="claude", deploymentKind=None),
    ]
    text, _ = harness(_wire(chain=chain), failing={"azure-openai", "lm-studio"})

    await core.interpreter_core_agent(_payload())

    assert [c["provider"] for c in text.calls] == ["azure-openai", "lm-studio", "bedrock"]
    assert text.calls[0]["provider_locality"] == {"azure-openai": "cloud"}
    assert text.calls[1]["provider_locality"] == {"lm-studio": "local"}
    # No kind ⇒ no stamp: text decides (fail-closed cloud).
    assert text.calls[2].get("provider_locality") is None


@pytest.mark.asyncio
async def test_no_deployment_kind_means_no_stamp(harness) -> None:
    text, _ = harness(_wire(chain=[], primary_kind=None), failing=set())

    await core.interpreter_core_agent(_payload())

    assert text.calls[0].get("provider_locality") is None


@pytest.mark.asyncio
async def test_known_phi_carries_the_identity_the_run_holds(harness) -> None:
    text, _ = harness(_wire(chain=[]), failing=set())

    await core.interpreter_core_agent(_payload())

    known = text.calls[0]["known_phi"]
    assert {"label": "patient_id", "value": "MRN-00042"} in known
    assert {"label": "person", "value": "Ada Lovelace"} in known


@pytest.mark.asyncio
async def test_a_stored_opt_out_is_ignored_and_the_call_is_screened(harness) -> None:
    text, recorded = harness(_wire(chain=[]), failing=set())

    result = await core.interpreter_core_agent(
        _payload({"agentRef": {"slug": "clinic-summarizer"}, "guardrail": {"enabled": False}})
    )

    assert result.status == "SUCCEEDED"
    assert "guardrail_policy" not in text.calls[0]
    assert recorded[0]["stats"]["guardrail"] == "screened"
    assert result.output is not None
    assert result.output["guardrail"]["enabled"] is True


@pytest.mark.asyncio
async def test_each_fallback_uses_its_own_output_schema(harness) -> None:
    chain = [
        _candidate(outputSchema=_FALLBACK_SCHEMA),
        _candidate(provider="bedrock", model="claude"),
    ]
    text, _ = harness(_wire(chain=chain), failing={"azure-openai", "lm-studio"})

    await core.interpreter_core_agent(_payload())

    formats = [c["response_format"]["json_schema"]["schema"] for c in text.calls]
    assert formats[0] == _PRIMARY_SCHEMA
    # The fallback that declares its own schema is constrained to IT, not the primary's.
    assert formats[1] == _FALLBACK_SCHEMA
    # A candidate that declares none falls back to the primary's.
    assert formats[2] == _PRIMARY_SCHEMA


@pytest.mark.asyncio
async def test_egress_counts_land_on_the_llm_call_stats(harness) -> None:
    egress = {
        "locality": "cloud",
        "detected": {"person": 1},
        "redacted": 1,
        "restored": 1,
        "images_unredacted": 0,
        "pii_leak_blocked": False,
    }
    _text, recorded = harness(_wire(chain=[]), failing=set(), egress=egress)

    await core.interpreter_core_agent(_payload())

    assert recorded[0]["stats"]["egress"] == egress
