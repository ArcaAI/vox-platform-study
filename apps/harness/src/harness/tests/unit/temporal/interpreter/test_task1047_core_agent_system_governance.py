"""TASK-1047 L10 / FC-6 — durable `core.agent` attaches `system_governance` only when verified."""

from __future__ import annotations

from typing import Any

import pytest

from harness.services import composed_prompt_recorder as recorder
from harness.services.api_client import ApiServiceError
from harness.services.guardrail_client import GuardrailServiceError
from harness.services.text_client import TextServiceError
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core
from harness.temporal.interpreter.output_language import default_output_language_step

_TENANT = "10000000-0000-0000-0000-000000000001"
_SYSTEM_TENANT = "00000000-0000-0000-0000-000000000000"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"
_ENGLISH_STEP = default_output_language_step("English")


def _wire(
    resolved_prompt: dict[str, Any],
    *,
    variables: dict[str, Any] | None = None,
    chain: list[dict[str, Any]] | None = None,
    context_schema: dict[str, Any] | None = None,
    governance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    instruction: dict[str, Any] = {"systemPrompt": resolved_prompt.get("content", "")}
    if variables is not None:
        instruction["variables"] = variables
    compiled: dict[str, Any] = {
        "task": "TEXT_GENERATION",
        "model": {"slug": "az-gpt", "provider": "azure"},
        "fallbacks": [],
        "instruction": instruction,
        "resolvedPrompt": resolved_prompt,
        "parameters": {},
    }
    if governance is not None:
        compiled["governance"] = governance
    if context_schema is not None:
        compiled["contextSchema"] = {"payloadSchema": context_schema}
    return {
        "agentId": "agent-1",
        "agentVersionId": "agent-1",
        "slug": "clinic-summarizer",
        "versionNumber": 3,
        "task": "TEXT_GENERATION",
        "tenantId": _TENANT,
        "source": "tenant",
        "compiledConfig": compiled,
        "models": [
            {
                "role": "primary",
                "slug": "az-gpt",
                "sourceUri": "gpt-5.4-mini",
                "provider": "azure",
                "tenantId": _TENANT,
                "deploymentKind": "BYOK",
            }
        ],
        "textFallback": {"autoSwitch": True, "chain": chain or []},
    }


def _fallback(content: str) -> dict[str, Any]:
    return {
        "kind": "platform-default",
        "agent": {
            "slug": "platform-summarization",
            "versionId": "p1",
            "versionNumber": 1,
            "tenantId": _SYSTEM_TENANT,
            "source": "platform-default",
        },
        "modelSlug": "lms-gemma",
        "provider": "lm-studio",
        "model": "gemma",
        "resolvedPrompt": {"source": "inline", "content": content},
        "instruction": {"systemPrompt": content},
        "parameters": {},
        "tools": [],
        "fundingTier": "platform",
        "deploymentKind": "SELF_HOSTED",
    }


def _payload(
    *,
    bound: dict[str, Any] | None = None,
    trigger: dict[str, Any] | None = None,
    config: dict[str, Any] | None = None,
) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="agent1",
        node_type="core.agent",
        config=config or {"agentRef": {"slug": "clinic-summarizer"}},
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs=bound if bound is not None else {"in": "Ada Lovelace reports chest pain."},
        run_payload={"consultationId": "c-1", "externalPatientId": "MRN-00042"},
        run_id=_RUN,
        run_context={"trigger": trigger if trigger is not None else {"patient": {"name": "Ada"}}},
    )


class _Result:
    def __init__(self, provider: str, egress: dict[str, Any] | None) -> None:
        self.content = "the note"
        self.provider = provider
        self.model = "m"
        self.usage = None
        self.stats = None
        self.usage_detail = None
        self.egress = egress


class _Text:
    def __init__(self, failing: set[str], egress: dict[str, Any] | None) -> None:
        self.failing = failing
        self.egress = egress
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> _Result:
        self.calls.append(kwargs)
        if kwargs["provider"] in self.failing:
            raise TextServiceError(f"{kwargs['provider']} down")
        return _Result(kwargs["provider"], self.egress)


@pytest.fixture
def run(monkeypatch: pytest.MonkeyPatch):
    recorded: list[tuple[dict[str, Any], str]] = []
    statuses: list[dict[str, Any]] = []

    async def _record_and_flush(_payload: Any, **kwargs: Any) -> None:
        statuses.append(kwargs)

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def _capture(body: dict[str, Any], tenant_id: str) -> None:
        recorded.append((body, tenant_id))

    monkeypatch.setattr(core, "record_and_flush", _record_and_flush)
    monkeypatch.setattr(core, "record_generation_and_flush", _noop)
    monkeypatch.setattr(recorder, "_send", _capture)

    async def _go(
        answer: dict[str, Any],
        payload: NodeActivityInput | None = None,
        *,
        failing: set[str] | None = None,
        egress: dict[str, Any] | None = None,
    ):
        text = _Text(failing or set(), egress if egress is not None else {"locality": "cloud"})

        class _Api:
            async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
                return answer

            async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
                return {}

        monkeypatch.setattr(core, "_api_client", lambda _settings: _Api())
        monkeypatch.setattr(core, "_text_client", lambda _settings: text)
        result = await core.interpreter_core_agent(payload or _payload())
        await recorder.drain_pending()
        return result, text.calls, recorded, statuses

    return _go


_PIECES = [
    {"kind": "PLATFORM", "key": "platform-rules@1", "digest": "d1"},
    {"kind": "TEMPLATE_BODY", "key": "body", "digest": "d2"},
]
_GOV = {"pieces": _PIECES, "composed_digest": "dc"}
_STAMP = {"policyVersion": "pv1", "pieceDigests": ["d1", "d2"]}


class _Guardrail:
    def __init__(self, answer: Any) -> None:
        self.answer = answer
        self.calls = 0

    async def policy_version(self, *, tenant_id: str) -> str:
        self.calls += 1
        assert tenant_id == _TENANT
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


verify_calls: list[dict[str, Any]] = []


@pytest.fixture
def go(monkeypatch: pytest.MonkeyPatch):
    async def _noop(*_a: Any, **_k: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)
    monkeypatch.setattr(core, "record_generation_and_flush", _noop)
    monkeypatch.setattr(recorder, "_send", _noop)

    async def _run(
        *,
        composed_gov: Any,
        stamp: Any,
        version: Any = "pv1",
        verify: Any = None,
    ) -> tuple[list[dict[str, Any]], _Guardrail]:
        verify = {"governed": True, "policyVersion": "pv1"} if verify is None else verify
        verify_calls.clear()
        text = _Text(set(), {"locality": "cloud"})
        guardrail = _Guardrail(version)
        answer = _wire({"source": "inline", "content": "Summarise."}, governance=stamp)

        class _Api:
            async def resolve_agent(self, **_k: Any) -> dict[str, Any]:
                return answer

            async def get_policy(self, *_a: Any, **_k: Any) -> dict[str, Any]:
                return {}

            async def verify_governed_prompts(self, **k: Any) -> dict[str, Any]:
                verify_calls.append(k)
                if isinstance(verify, Exception):
                    raise verify
                return verify

        real = core._compose_agent_messages

        def _compose(*a: Any, **k: Any):
            composed, selected = real(*a, **k)
            object.__setattr__(
                composed, "governance", composed_gov
            )  # what L1's composer returns (FC-2)
            return composed, selected

        monkeypatch.setattr(core, "_compose_agent_messages", _compose)
        monkeypatch.setattr(core, "_api_client", lambda _s: _Api())
        monkeypatch.setattr(core, "_text_client", lambda _s: text)
        monkeypatch.setattr(core, "_guardrail_client", lambda _s: guardrail)
        result = await core.interpreter_core_agent(_payload())
        assert result.status == "SUCCEEDED"
        return text.calls, guardrail

    return _run


class TestSystemGovernance:
    @pytest.mark.asyncio
    async def test_sent_when_all_digests_stamped_and_versions_match(self, go) -> None:
        calls, guardrail = await go(composed_gov=_GOV, stamp=_STAMP)
        assert calls[0]["system_governance"] == {
            "composed_digest": "dc",
            "pieces": _PIECES,
            "policy_version": "pv1",
        }
        assert guardrail.calls == 1

    @pytest.mark.asyncio
    async def test_omitted_when_a_digest_is_not_stamped(self, go) -> None:
        calls, _ = await go(
            composed_gov=_GOV, stamp={"policyVersion": "pv1", "pieceDigests": ["d1"]}
        )
        assert calls[0].get("system_governance") is None

    @pytest.mark.asyncio
    async def test_omitted_without_a_stamp(self, go) -> None:
        calls, _ = await go(composed_gov=_GOV, stamp=None)
        assert calls[0].get("system_governance") is None

    @pytest.mark.asyncio
    async def test_omitted_on_policy_version_mismatch(self, go) -> None:
        calls, _ = await go(composed_gov=_GOV, stamp=_STAMP, version="pv2")
        assert calls[0].get("system_governance") is None

    @pytest.mark.asyncio
    async def test_omitted_when_the_version_fetch_fails(self, go) -> None:
        calls, _ = await go(composed_gov=_GOV, stamp=_STAMP, version=GuardrailServiceError("down"))
        assert calls[0].get("system_governance") is None

    @pytest.mark.asyncio
    async def test_omitted_and_no_fetch_when_the_composer_reports_no_governance(self, go) -> None:
        calls, guardrail = await go(composed_gov=None, stamp=_STAMP)
        assert calls[0].get("system_governance") is None
        assert guardrail.calls == 0

    @pytest.mark.asyncio
    async def test_omitted_when_the_gateway_says_not_governed(self, go) -> None:
        calls, _ = await go(
            composed_gov=_GOV, stamp=_STAMP, verify={"governed": False, "policyVersion": "pv1"}
        )
        assert calls[0].get("system_governance") is None
        assert verify_calls[0]["digests"] == ["d1", "d2"]
        assert verify_calls[0]["tenant_id"] == _TENANT

    @pytest.mark.asyncio
    async def test_omitted_when_the_gateway_version_differs_from_guardrails(self, go) -> None:
        calls, _ = await go(
            composed_gov=_GOV, stamp=_STAMP, verify={"governed": True, "policyVersion": "pv0"}
        )
        assert calls[0].get("system_governance") is None

    @pytest.mark.asyncio
    async def test_omitted_when_verification_fails(self, go) -> None:
        calls, _ = await go(composed_gov=_GOV, stamp=_STAMP, verify=ApiServiceError("down"))
        assert calls[0].get("system_governance") is None

    @pytest.mark.asyncio
    async def test_platform_pieces_need_not_be_stamped_when_the_gateway_confirms_them(
        self, go
    ) -> None:
        calls, _ = await go(
            composed_gov=_GOV, stamp={"policyVersion": "pv1", "pieceDigests": ["d2"]}
        )
        assert calls[0]["system_governance"]["composed_digest"] == "dc"
        assert len(verify_calls) == 1

    @pytest.mark.asyncio
    async def test_no_verification_call_without_a_stamp(self, go) -> None:
        await go(composed_gov=_GOV, stamp=None)
        assert verify_calls == []
