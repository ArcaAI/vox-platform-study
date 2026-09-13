"""TASK-970 — the reasoning posture must reach the wire of EVERY adapter.

Before this ticket the posture travelled as a pre-rendered OpenAI-shaped
``extra.reasoning_effort`` ride-along, and only ``openai_compat`` (plus its two
subclasses) read ``request.extra`` at all. Seven adapters dropped it silently —
including ``openai`` and ``azure_openai``, the two engines where
``reasoning_effort`` IS the correct native parameter.

These tests are driven off the committed cross-language contract
``tests/contracts/reasoning-posture.fixture.json`` so the contract and the code
cannot drift: the four wire cases are read from ``wire.cases`` and the
per-adapter capability from ``support``.

RED: written before the implementation.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from text.models.requests import GenerateRequest
from text.tests.conftest import stub_client, stub_endpoint


def _load_fixture() -> dict[str, Any]:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "tests" / "contracts" / "reasoning-posture.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared reasoning-posture contract fixture not found")


FIXTURE = _load_fixture()
SUPPORT: dict[str, Any] = {k: v for k, v in FIXTURE["support"].items() if not k.startswith("$")}
CASES: dict[str, Any] = {c["name"]: c["posture"] for c in FIXTURE["wire"]["cases"]}

OFF = CASES["off"]
ON = CASES["on-unspecified"]
ON_EFFORT = CASES["on-effort"]
ABSENT = CASES["absent"]


@pytest.fixture
def recorded(monkeypatch) -> list[tuple[str, dict[str, Any]]]:
    """Every ``record_unenforceable`` call this test made.

    structlog is not wired into stdlib logging here, so the suite's house
    pattern is to patch the module logger (see `test_code_quality.py`) rather
    than reach for ``caplog``.
    """
    calls: list[tuple[str, dict[str, Any]]] = []

    class _Recorder:
        def warning(self, event: str, **kw: Any) -> None:
            calls.append((event, kw))

    monkeypatch.setattr("text.core.reasoning.logger", _Recorder())
    return calls


def _req(**overrides: Any) -> GenerateRequest:
    payload: dict[str, Any] = {"prompt": "hello", "model": "caller-model"}
    payload.update(overrides)
    return GenerateRequest(**payload)


# ---------------------------------------------------------------------------
# 1. The wire model — the posture travels as a posture, not as an effort string
# ---------------------------------------------------------------------------


class TestWireModel:
    def test_absent_is_none_not_a_synthesized_default(self):
        assert _req().reasoning is None

    def test_off_is_distinguishable_from_minimal_effort(self):
        off = _req(reasoning=OFF).reasoning
        minimal = _req(reasoning={"enabled": True, "effort": "minimal"}).reasoning
        assert off is not None and minimal is not None
        assert off.enabled is False and off.effort is None
        assert minimal.enabled is True and minimal.effort == "minimal"

    def test_on_without_an_effort_names_no_budget(self):
        posture = _req(reasoning=ON).reasoning
        assert posture is not None
        assert posture.enabled is True
        assert posture.effort is None

    def test_effort_vocabulary_is_closed(self):
        from pydantic import ValidationError

        for good in ("minimal", "low", "medium", "high"):
            assert _req(reasoning={"enabled": True, "effort": good}).reasoning.effort == good
        with pytest.raises(ValidationError):
            _req(reasoning={"enabled": True, "effort": "ludicrous"})


# ---------------------------------------------------------------------------
# 2. Every adapter DECLARES its capability, and the declaration matches the
#    committed contract. A silent drop is impossible once a declaration exists.
# ---------------------------------------------------------------------------


def _adapters() -> dict[str, Any]:
    from text.providers.anthropic import AnthropicProvider
    from text.providers.azure_openai import AzureOpenAIProvider
    from text.providers.bedrock import BedrockProvider
    from text.providers.llama_cpp import LlamaCppProvider
    from text.providers.lmstudio import LMStudioProvider
    from text.providers.ollama import OllamaProvider
    from text.providers.openai import OpenAIProvider
    from text.providers.openai_compat import OpenAICompatProvider
    from text.providers.vertex import VertexProvider
    from text.providers.vllm import VllmProvider

    return {
        "openai": OpenAIProvider,
        "azure_openai": AzureOpenAIProvider,
        "openai_compat": OpenAICompatProvider,
        "lmstudio": LMStudioProvider,
        "vllm": VllmProvider,
        "ollama": OllamaProvider,
        "anthropic": AnthropicProvider,
        "vertex": VertexProvider,
        "llama_cpp": LlamaCppProvider,
        "bedrock": BedrockProvider,
    }


class TestContractParity:
    def test_every_fixture_provider_has_an_adapter(self):
        assert set(SUPPORT) == set(_adapters())

    @pytest.mark.parametrize("name", sorted(SUPPORT))
    def test_adapter_declares_the_contracted_capability(self, name):
        adapter = _adapters()[name]
        entry = SUPPORT[name]
        assert str(adapter.reasoning_support) == entry["class"]
        assert adapter.reasoning_parameter == entry["renders"]
        assert adapter.reasoning_effort_parameter == entry["effort"]

    def test_no_adapter_is_left_undeclared(self):
        """Default-deny: a new adapter must state its posture capability."""
        from text.core.reasoning import ReasoningSupport

        for adapter in _adapters().values():
            assert isinstance(adapter.reasoning_support, ReasoningSupport)


# ---------------------------------------------------------------------------
# 3. The OpenAI wire — `reasoning_effort`
# ---------------------------------------------------------------------------


def _openai_response() -> MagicMock:
    resp = MagicMock()
    choice = MagicMock()
    choice.message.content = "Hello"
    choice.message.reasoning_content = None
    choice.message.reasoning = None
    choice.finish_reason = "stop"
    resp.choices = [choice]
    resp.usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)
    resp.stats = None
    return resp


def _openai_wire(factory) -> Any:
    provider = factory()
    client = stub_client(provider, MagicMock())
    client.chat.completions.create = AsyncMock(return_value=_openai_response())
    return provider


async def _openai_body(provider, **overrides) -> dict[str, Any]:
    await provider.generate(_req(**overrides))
    return dict(provider._client_for(None).chat.completions.create.call_args.kwargs)


def _make_openai() -> Any:
    from text.providers.openai import OpenAIProvider

    return OpenAIProvider()


def _make_azure() -> Any:
    from text.providers.azure_openai import AzureOpenAIProvider

    return AzureOpenAIProvider()


def _make_compat() -> Any:
    from text.providers.openai_compat import OpenAICompatProvider

    return OpenAICompatProvider()


def _make_lmstudio() -> Any:
    from text.providers.lmstudio import LMStudioProvider

    return LMStudioProvider()


@pytest.mark.parametrize("factory", [_make_openai, _make_azure], ids=["openai", "azure_openai"])
class TestNativeOffOpenAIWire:
    """`reasoning_effort: "none"` is a real rung of the pinned SDK's own literal."""

    @pytest.mark.asyncio
    async def test_off_renders_the_none_rung(self, factory):
        body = await _openai_body(_openai_wire(factory), reasoning=OFF)
        assert body["reasoning_effort"] == "none"

    @pytest.mark.asyncio
    async def test_on_with_an_effort_renders_that_effort(self, factory):
        body = await _openai_body(_openai_wire(factory), reasoning=ON_EFFORT)
        assert body["reasoning_effort"] == ON_EFFORT["effort"]

    @pytest.mark.asyncio
    async def test_on_without_an_effort_pins_no_budget(self, factory):
        body = await _openai_body(_openai_wire(factory), reasoning=ON)
        assert "reasoning_effort" not in body

    @pytest.mark.asyncio
    async def test_absent_synthesizes_nothing(self, factory):
        body = await _openai_body(_openai_wire(factory), reasoning=ABSENT)
        assert "reasoning_effort" not in body

    @pytest.mark.asyncio
    async def test_streaming_carries_the_posture_too(self, factory):
        provider = _openai_wire(factory)
        provider._client_for(None).chat.completions.create = AsyncMock(return_value=_aempty())
        async for _ in provider.generate_stream(_req(reasoning=OFF)):
            pass
        body = provider._client_for(None).chat.completions.create.call_args.kwargs
        assert body["reasoning_effort"] == "none"


async def _aempty():
    for item in ():  # pragma: no cover - an empty async iterator
        yield item


@pytest.mark.parametrize("factory", [_make_compat, _make_lmstudio], ids=["openai_compat", "lm"])
class TestEffortOnlyOpenAIWire:
    """A generic OpenAI-wire server has an effort dial but no promised off rung.

    OFF is RECORDED rather than approximated onto a low effort — that lossy
    mapping is precisely what this contract exists to remove.
    """

    @pytest.mark.asyncio
    async def test_effort_is_rendered(self, factory):
        body = await _openai_body(_openai_wire(factory), reasoning=ON_EFFORT)
        assert body["reasoning_effort"] == ON_EFFORT["effort"]

    @pytest.mark.asyncio
    async def test_off_is_not_approximated(self, factory):
        body = await _openai_body(_openai_wire(factory), reasoning=OFF)
        assert "reasoning_effort" not in body

    @pytest.mark.asyncio
    async def test_off_is_recorded_and_the_call_still_runs(self, factory, recorded):
        provider = _openai_wire(factory)
        content, _reasoning, _stats = await provider.generate(_req(reasoning=OFF))
        assert content == "Hello"
        assert [e for e, _ in recorded] == ["text.reasoning.unenforceable"]


class TestLmStudioRetentionHintSurvives:
    @pytest.mark.asyncio
    async def test_ttl_and_reasoning_coexist(self):
        provider = _openai_wire(_make_lmstudio)
        body = await _openai_body(provider, reasoning=ON_EFFORT)
        assert body["extra_body"]["ttl"] == provider._retention_ttl_s
        assert body["reasoning_effort"] == ON_EFFORT["effort"]


# ---------------------------------------------------------------------------
# 4. vLLM — the chat-template toggle, never the OpenAI effort word
# ---------------------------------------------------------------------------


class TestVllmChatTemplateToggle:
    def _kwargs(self, reasoning) -> dict[str, Any]:
        from text.providers.vllm import VllmProvider

        provider = VllmProvider()
        kwargs: dict[str, Any] = {}
        provider._apply_reasoning(kwargs, _req(reasoning=reasoning))
        return kwargs

    def test_off_disables_thinking_in_the_chat_template(self):
        kwargs = self._kwargs(OFF)
        assert kwargs["extra_body"]["chat_template_kwargs"]["enable_thinking"] is False

    def test_on_enables_it(self):
        kwargs = self._kwargs(ON)
        assert kwargs["extra_body"]["chat_template_kwargs"]["enable_thinking"] is True

    def test_absent_sends_nothing(self):
        assert self._kwargs(ABSENT) == {}

    def test_never_sends_the_openai_effort_word(self):
        assert "reasoning_effort" not in self._kwargs(ON_EFFORT)

    def test_a_named_effort_is_recorded(self, recorded):
        self._kwargs(ON_EFFORT)
        assert [e for e, _ in recorded] == ["text.reasoning.unenforceable"]


# ---------------------------------------------------------------------------
# 5. Ollama — `think`, and the hardcoded `think: true` is gone
# ---------------------------------------------------------------------------


def _ollama():
    from text.providers.ollama import OllamaProvider

    provider = OllamaProvider(AsyncMock(spec=httpx.AsyncClient))
    stub_endpoint(provider)
    return provider


class TestOllamaThink:
    def test_off_sends_think_false(self):
        payload = _ollama()._build_payload(_req(reasoning=OFF), stream=False)
        assert payload["think"] is False

    def test_on_sends_think_true(self):
        payload = _ollama()._build_payload(_req(reasoning=ON), stream=False)
        assert payload["think"] is True

    def test_absent_sends_no_think_key_at_all(self):
        """The adapter used to hardcode ``think: True`` on EVERY request.

        That literal was a hardcoded reasoning SELECTION, and it is the reason an
        admin who turned reasoning off on an Ollama-bound agent was billed for
        thinking tokens anyway.
        """
        payload = _ollama()._build_payload(_req(reasoning=ABSENT), stream=False)
        assert "think" not in payload

    def test_a_named_effort_is_recorded_but_thinking_is_still_enabled(self, recorded):
        payload = _ollama()._build_payload(_req(reasoning=ON_EFFORT), stream=False)
        assert payload["think"] is True
        assert [e for e, _ in recorded] == ["text.reasoning.unenforceable"]

    def test_streaming_shares_the_builder(self):
        payload = _ollama()._build_payload(_req(reasoning=OFF), stream=True)
        assert payload["think"] is False


# ---------------------------------------------------------------------------
# 6. Anthropic — extended thinking is opt-IN, so ON must be sent explicitly
# ---------------------------------------------------------------------------


def _anthropic():
    from text.providers.anthropic import AnthropicProvider

    return AnthropicProvider()


class TestAnthropicThinking:
    def test_off_disables_extended_thinking(self):
        kwargs = _anthropic()._build_create_kwargs(_req(reasoning=OFF))
        assert kwargs["thinking"] == {"type": "disabled"}

    def test_on_without_a_budget_uses_adaptive(self):
        """`budget_tokens` is REQUIRED on the enabled variant and is a token
        COUNT — not an effort rung — so the adapter must not invent one."""
        kwargs = _anthropic()._build_create_kwargs(_req(reasoning=ON))
        assert kwargs["thinking"] == {"type": "adaptive"}

    def test_absent_sends_no_thinking_block(self):
        kwargs = _anthropic()._build_create_kwargs(_req(reasoning=ABSENT))
        assert "thinking" not in kwargs

    def test_a_named_effort_is_recorded(self, recorded):
        kwargs = _anthropic()._build_create_kwargs(_req(reasoning=ON_EFFORT))
        assert kwargs["thinking"] == {"type": "adaptive"}
        assert [e for e, _ in recorded] == ["text.reasoning.unenforceable"]


# ---------------------------------------------------------------------------
# 7. Vertex — thinking_budget=0 is DISABLED; thinking_level is the dial
# ---------------------------------------------------------------------------


def _vertex():
    from text.providers.vertex import VertexProvider

    return VertexProvider()


class TestVertexThinkingConfig:
    def test_off_sets_a_zero_thinking_budget(self):
        config = _vertex()._build_config(_req(reasoning=OFF))
        assert config.thinking_config is not None
        assert config.thinking_config.thinking_budget == 0

    def test_on_with_an_effort_sets_the_matching_thinking_level(self):
        config = _vertex()._build_config(_req(reasoning=ON_EFFORT))
        assert config.thinking_config is not None
        assert str(config.thinking_config.thinking_level).endswith(ON_EFFORT["effort"].upper())

    def test_on_without_an_effort_leaves_the_engine_default(self):
        config = _vertex()._build_config(_req(reasoning=ON))
        assert config.thinking_config is None

    def test_absent_sends_no_thinking_config(self):
        config = _vertex()._build_config(_req(reasoning=ABSENT))
        assert config.thinking_config is None


# ---------------------------------------------------------------------------
# 8. Unenforceable engines — log and proceed, NEVER raise, never send a guess
# ---------------------------------------------------------------------------


def _bedrock():
    from text.providers.bedrock import BedrockProvider

    with patch("boto3.client"):
        provider = BedrockProvider()
    client = stub_client(provider, MagicMock())
    client.converse.return_value = {
        "output": {"message": {"content": [{"text": "Hello"}]}},
        "usage": {"inputTokens": 1, "outputTokens": 1},
        "stopReason": "end_turn",
    }
    return provider


def _llama_cpp():
    from text.providers.llama_cpp import LlamaCppProvider

    provider = LlamaCppProvider(AsyncMock(spec=httpx.AsyncClient))
    stub_endpoint(provider)
    return provider


class TestUnsupportedEnginesRecordAndProceed:
    @pytest.mark.parametrize("posture", [OFF, ON, ON_EFFORT], ids=["off", "on", "on-effort"])
    def test_bedrock_sends_no_invented_model_field(self, posture, recorded):
        params = _bedrock()._build_converse_params(_req(reasoning=posture))
        assert "additionalModelRequestFields" not in params
        assert [e for e, _ in recorded] == ["text.reasoning.unenforceable"]

    def test_bedrock_absent_records_nothing(self, recorded):
        _bedrock()._build_converse_params(_req(reasoning=ABSENT))
        assert recorded == []

    @pytest.mark.parametrize("posture", [OFF, ON, ON_EFFORT], ids=["off", "on", "on-effort"])
    def test_llama_cpp_payload_is_untouched(self, posture, recorded):
        payload = _llama_cpp()._build_payload(_req(reasoning=posture), stream=False)
        for foreign in ("think", "reasoning_effort", "chat_template_kwargs", "reasoning_budget"):
            assert foreign not in payload
        assert [e for e, _ in recorded] == ["text.reasoning.unenforceable"]

    @pytest.mark.asyncio
    async def test_an_unenforceable_posture_never_fails_the_call(self):
        """The owner decision: log and proceed. No 422, no raise, no outage risk
        on a provider swap."""
        content, _reasoning, _stats = await _bedrock().generate(_req(reasoning=OFF))
        assert content == "Hello"

    def test_the_record_names_the_provider_model_and_posture(self, recorded):
        from text.core.reasoning import record_unenforceable
        from text.models.requests import ReasoningPosture

        record_unenforceable(
            provider="bedrock",
            model="anthropic.claude-x",
            posture=ReasoningPosture(enabled=False),
            reason="engine_cannot_express_posture",
        )
        event, fields = recorded[0]
        assert event == "text.reasoning.unenforceable"
        assert fields["provider"] == "bedrock"
        assert fields["model"] == "anthropic.claude-x"
        assert fields["reason"] == "engine_cannot_express_posture"
        assert fields["reasoning_enabled"] is False


# ---------------------------------------------------------------------------
# 9. CALLER WINS, per key — a pinned raw ride-along is never second-guessed
# ---------------------------------------------------------------------------


class TestCallerPinnedExtraWins:
    def test_the_posture_is_not_rendered_over_a_pinned_extra(self):
        from text.core.reasoning import posture_to_render

        request = _req(reasoning=OFF, extra={"reasoning_effort": "low"})
        assert posture_to_render(request) is None

    def test_an_unpinned_request_renders_its_posture(self):
        from text.core.reasoning import posture_to_render

        request = _req(reasoning=OFF, extra={"n_threads": 4})
        assert posture_to_render(request) == request.reasoning

    @pytest.mark.asyncio
    async def test_the_pin_still_rides_through_on_the_compat_family(self):
        provider = _openai_wire(_make_compat)
        body = await _openai_body(provider, reasoning=OFF, extra={"reasoning_effort": "low"})
        assert body["extra_body"]["reasoning_effort"] == "low"
        assert "reasoning_effort" not in body
