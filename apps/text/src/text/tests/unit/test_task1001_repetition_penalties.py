"""TASK-1001 OD-10 — decode-time repetition pressure reaches the engines that honour it.

`frequencyPenalty` / `presencePenalty` were authorable on an agent
(`GENERATION_PROPERTY`, `packages/workflow-contract/src/agent-schemas.ts`) and
servable as a platform default, but NOTHING in this service read them:
`resolve_request_defaults` resolved exactly `{temperature, max_tokens, top_p}`
and no adapter mentioned a penalty. A 2B model at temperature 0 wrote clinical
notes that repeated whole sentences, and the knob meant to push back on that
went nowhere.

The contract these tests pin, stated once:

* The chain mirrors `top_p` — request value > platform default served on
  `/internal/effective-config` — but ends in NOTHING rather than a floor.
  `GENERATION_FLOOR` does not change.
* ABSENT and ``0`` are both "not sent". The descriptor ships ``0``, so every
  deployment keeps byte-identical provider requests until an admin sets a
  non-zero value.
* A non-zero value is forwarded by an adapter whose engine documents the
  parameter, and DROPPED — with a debug log naming the provider, never an
  error — by one whose engine does not.

RED: written before the implementation.
"""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from pydantic import ValidationError

from text.models.requests import GenerateRequest
from text.tests.conftest import stub_client, stub_endpoint

PENALTIES = ("frequency_penalty", "presence_penalty")

_REPO_ROOT = Path(__file__).resolve().parents[6]
_AGENT_SCHEMAS_TS = _REPO_ROOT / "packages/workflow-contract/src/agent-schemas.ts"


def _req(**overrides: Any) -> GenerateRequest:
    payload: dict[str, Any] = {"prompt": "hello", "model": "caller-model"}
    payload.update(overrides)
    return GenerateRequest(**payload)


@pytest.fixture(autouse=True)
def _restore_process_defaults():
    """The served profile lives in MODULE state (`core/defaults._ACTIVE`), so a
    test that adopts one must hand the process back with no opinion."""
    from text.core.defaults import apply_generation_defaults

    apply_generation_defaults({})
    yield
    apply_generation_defaults({})


@pytest.fixture
def dropped(monkeypatch) -> list[tuple[str, dict[str, Any]]]:
    """Every debug record the penalty-drop path made.

    structlog is not wired into stdlib logging here, so the suite's house
    pattern is to patch the module logger rather than reach for ``caplog``.
    """
    calls: list[tuple[str, dict[str, Any]]] = []

    class _Recorder:
        def debug(self, event: str, **kw: Any) -> None:
            calls.append((event, kw))

    monkeypatch.setattr("text.core.defaults.logger", _Recorder())
    return calls


# ---------------------------------------------------------------------------
# 1. The wire model — optional floats, bounded like the agent schema
# ---------------------------------------------------------------------------


class TestWireModel:
    @pytest.mark.parametrize("name", PENALTIES)
    def test_absent_is_none(self, name):
        assert getattr(_req(), name) is None

    @pytest.mark.parametrize("name", PENALTIES)
    @pytest.mark.parametrize("value", [-2.0, -0.5, 0.0, 0.7, 2.0])
    def test_in_range_values_are_preserved(self, name, value):
        assert getattr(_req(**{name: value}), name) == value

    @pytest.mark.parametrize("name", PENALTIES)
    @pytest.mark.parametrize("value", [-2.01, 2.01, 5.0, -100.0])
    def test_an_out_of_range_value_is_rejected(self, name, value):
        with pytest.raises(ValidationError):
            _req(**{name: value})

    def test_the_bounds_are_the_agent_schema_bounds(self):
        """Cross-language: the Python bounds are READ against the TypeScript
        `GENERATION_PROPERTY`, not restated from memory. An agent that publishes
        a value the text service would 422 is a failed generation at run time."""
        from text.core.defaults import PENALTY_MAX, PENALTY_MIN

        assert _AGENT_SCHEMAS_TS.is_file(), f"missing: {_AGENT_SCHEMAS_TS}"
        source = _AGENT_SCHEMAS_TS.read_text(encoding="utf-8")
        block = re.search(r"const GENERATION_PROPERTY\b.*?\n\}\);", source, re.S)
        assert block is not None, "GENERATION_PROPERTY is no longer a frozen literal"

        for ts_name in ("frequencyPenalty", "presencePenalty"):
            match = re.search(
                rf"{ts_name}: Object\.freeze\(\{{\s*type: 'number',\s*"
                r"minimum: (?P<min>-?\d+(?:\.\d+)?),\s*maximum: (?P<max>-?\d+(?:\.\d+)?)",
                block.group(0),
            )
            assert match is not None, f"{ts_name} bounds not found in GENERATION_PROPERTY"
            assert float(match.group("min")) == PENALTY_MIN
            assert float(match.group("max")) == PENALTY_MAX


# ---------------------------------------------------------------------------
# 2. Resolution — request > served default > NOTHING (no floor)
# ---------------------------------------------------------------------------


class TestResolution:
    def test_the_floor_is_unchanged(self):
        """There is no floor for a penalty. Adding one would change what every
        unprofiled request sends — the opposite of this ticket's promise."""
        from text.core.defaults import GENERATION_FLOOR

        assert GENERATION_FLOOR == {"temperature": 0.1, "max_tokens": 16_384, "top_p": 0.95}

    def test_absent_everywhere_is_not_sent(self):
        from text.core.defaults import resolve_request_defaults

        resolved = resolve_request_defaults(_req())
        assert resolved == {"temperature": 0.1, "max_tokens": 16_384, "top_p": 0.95}

    @pytest.mark.parametrize("name", PENALTIES)
    def test_an_explicit_zero_is_not_sent(self, name):
        from text.core.defaults import resolve_request_defaults

        assert name not in resolve_request_defaults(_req(**{name: 0.0}))

    @pytest.mark.parametrize("name", PENALTIES)
    @pytest.mark.parametrize("value", [0.4, -0.3])
    def test_a_non_zero_request_value_is_resolved(self, name, value):
        from text.core.defaults import resolve_request_defaults

        assert resolve_request_defaults(_req(**{name: value}))[name] == value

    @pytest.mark.parametrize("name", PENALTIES)
    def test_the_served_default_applies_when_the_request_omits_it(self, name):
        from text.core.defaults import apply_generation_defaults, resolve_request_defaults

        apply_generation_defaults({name: 0.5})
        assert resolve_request_defaults(_req())[name] == 0.5

    @pytest.mark.parametrize("name", PENALTIES)
    def test_the_request_value_wins_over_the_served_default(self, name):
        from text.core.defaults import apply_generation_defaults, resolve_request_defaults

        apply_generation_defaults({name: 0.5})
        assert resolve_request_defaults(_req(**{name: 0.2}))[name] == 0.2

    @pytest.mark.parametrize("name", PENALTIES)
    def test_an_explicit_zero_wins_over_a_served_default(self, name):
        """``0`` from the caller is a real value (the agent said "neutral"), not
        "unset" — it must not fall through to the platform default, exactly as
        `temperature=0.0` does not."""
        from text.core.defaults import apply_generation_defaults, resolve_request_defaults

        apply_generation_defaults({name: 0.5})
        assert name not in resolve_request_defaults(_req(**{name: 0.0}))

    @pytest.mark.parametrize("name", PENALTIES)
    def test_a_served_zero_is_not_sent(self, name):
        """The descriptor's shipped default. It must leave requests untouched."""
        from text.core.defaults import apply_generation_defaults, resolve_request_defaults

        apply_generation_defaults({name: 0.0})
        assert name not in resolve_request_defaults(_req())

    def test_a_served_penalty_does_not_disturb_the_floored_keys(self):
        from text.core.defaults import apply_generation_defaults, resolve_request_defaults

        apply_generation_defaults({"frequency_penalty": 0.5})
        resolved = resolve_request_defaults(_req())
        assert resolved == {
            "temperature": 0.1,
            "max_tokens": 16_384,
            "top_p": 0.95,
            "frequency_penalty": 0.5,
        }


# ---------------------------------------------------------------------------
# 3. The PULL channel — the served group fields are camelCase, like `topP`
# ---------------------------------------------------------------------------


class TestServedGroup:
    def _generation(self, group: dict[str, Any]) -> dict[str, Any]:
        from text.core.effective_config import EffectiveConfigSnapshot

        return EffectiveConfigSnapshot(raw={"generation": group}, ok=True).generation_defaults()

    def test_the_group_fields_map_onto_the_resolved_keys(self):
        resolved = self._generation({"frequencyPenalty": 0.3, "presencePenalty": -0.2})
        assert resolved == {"frequency_penalty": 0.3, "presence_penalty": -0.2}

    def test_a_served_zero_is_read_faithfully(self):
        """The reader reports what was served; neutralising it is resolution's job."""
        resolved = self._generation({"frequencyPenalty": 0, "presencePenalty": 0})
        assert resolved == {"frequency_penalty": 0.0, "presence_penalty": 0.0}

    @pytest.mark.parametrize("value", [None, True, "0.5", 2.5, -2.5, float("nan")])
    def test_an_unusable_served_value_is_no_opinion(self, value):
        """Null (`numberOrNull`), a bool, a string or an out-of-range number is
        refused — not coerced into the range, and never an error."""
        resolved = self._generation({"frequencyPenalty": value, "presencePenalty": value})
        assert "frequency_penalty" not in resolved
        assert "presence_penalty" not in resolved

    def test_the_boundaries_are_accepted(self):
        resolved = self._generation({"frequencyPenalty": -2, "presencePenalty": 2})
        assert resolved == {"frequency_penalty": -2.0, "presence_penalty": 2.0}

    def test_a_served_penalty_reaches_resolution_end_to_end(self):
        from text.core.defaults import resolve_request_defaults
        from text.core.effective_config import EffectiveConfigSnapshot
        from text.services.runtime_limits import apply_platform_posture

        apply_platform_posture(
            EffectiveConfigSnapshot(
                raw={"generation": {"frequencyPenalty": 0.4, "presencePenalty": 0.0}}, ok=True
            ),
            SimpleNamespace(guardrail_posture=None),
        )
        resolved = resolve_request_defaults(_req())
        assert resolved["frequency_penalty"] == 0.4
        assert "presence_penalty" not in resolved


# ---------------------------------------------------------------------------
# 4. Adapters that FORWARD — the OpenAI chat-completions wire
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


async def _aempty():
    for item in ():  # pragma: no cover - an empty async iterator
        yield item


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


def _make_vllm() -> Any:
    from text.providers.vllm import VllmProvider

    return VllmProvider()


def _openai_wire(factory) -> Any:
    provider = factory()
    client = stub_client(provider, MagicMock())
    client.chat.completions.create = AsyncMock(return_value=_openai_response())
    return provider


async def _generate_body(factory, **overrides: Any) -> dict[str, Any]:
    provider = _openai_wire(factory)
    await provider.generate(_req(**overrides))
    return dict(provider._client_for(None).chat.completions.create.call_args.kwargs)


async def _stream_body(factory, **overrides: Any) -> dict[str, Any]:
    provider = _openai_wire(factory)
    provider._client_for(None).chat.completions.create = AsyncMock(return_value=_aempty())
    async for _ in provider.generate_stream(_req(**overrides)):
        pass
    return dict(provider._client_for(None).chat.completions.create.call_args.kwargs)


# LM Studio FIRST: it is the engine that serves `gemma-4-e2b-it-qat` in production.
OPENAI_WIRE = pytest.mark.parametrize(
    "factory",
    [_make_lmstudio, _make_compat, _make_vllm, _make_openai, _make_azure],
    ids=["lmstudio", "openai_compat", "vllm", "openai", "azure_openai"],
)


@OPENAI_WIRE
class TestOpenAIWireForwards:
    @pytest.mark.asyncio
    async def test_generate_puts_both_penalties_on_the_body(self, factory):
        body = await _generate_body(factory, frequency_penalty=0.4, presence_penalty=0.3)
        assert body["frequency_penalty"] == 0.4
        assert body["presence_penalty"] == 0.3

    @pytest.mark.asyncio
    async def test_streaming_carries_them_too(self, factory):
        body = await _stream_body(factory, frequency_penalty=0.4, presence_penalty=0.3)
        assert body["frequency_penalty"] == 0.4
        assert body["presence_penalty"] == 0.3

    @pytest.mark.asyncio
    async def test_a_served_default_reaches_the_body(self, factory):
        from text.core.defaults import apply_generation_defaults

        apply_generation_defaults({"frequency_penalty": 0.25})
        body = await _generate_body(factory)
        assert body["frequency_penalty"] == 0.25
        assert "presence_penalty" not in body

    @pytest.mark.asyncio
    async def test_absent_sends_nothing(self, factory):
        body = await _generate_body(factory)
        for name in PENALTIES:
            assert name not in body

    @pytest.mark.asyncio
    async def test_zero_sends_nothing(self, factory):
        body = await _generate_body(factory, frequency_penalty=0.0, presence_penalty=0.0)
        for name in PENALTIES:
            assert name not in body

    @pytest.mark.asyncio
    async def test_only_the_non_zero_one_is_sent(self, factory):
        body = await _generate_body(factory, frequency_penalty=0.0, presence_penalty=0.6)
        assert "frequency_penalty" not in body
        assert body["presence_penalty"] == 0.6


class TestLmStudioSpecifically:
    """The production engine. The penalties are TYPED parameters of the pinned
    OpenAI SDK and documented by LM Studio's `/v1/chat/completions`, so they
    ride top-level — never inside `extra_body`, whose one job here is `ttl`."""

    @pytest.mark.asyncio
    async def test_penalties_are_top_level_and_ttl_is_untouched(self):
        provider = _openai_wire(_make_lmstudio)
        await provider.generate(_req(frequency_penalty=0.4, presence_penalty=0.3))
        body = provider._client_for(None).chat.completions.create.call_args.kwargs
        assert body["extra_body"] == {"ttl": provider._retention_ttl_s}
        assert body["frequency_penalty"] == 0.4
        assert body["presence_penalty"] == 0.3

    @pytest.mark.asyncio
    async def test_forwarding_logs_no_drop(self, dropped):
        await _generate_body(_make_lmstudio, frequency_penalty=0.4)
        assert dropped == []


# ---------------------------------------------------------------------------
# 5. llama.cpp — the native `/completion` endpoint documents both penalties
# ---------------------------------------------------------------------------


def _llama_cpp():
    from text.providers.llama_cpp import LlamaCppProvider

    provider = LlamaCppProvider(AsyncMock(spec=httpx.AsyncClient))
    stub_endpoint(provider)
    return provider


class TestLlamaCppForwards:
    def test_the_payload_carries_both_penalties(self):
        payload = _llama_cpp()._build_payload(
            _req(frequency_penalty=0.4, presence_penalty=0.3), stream=False
        )
        assert payload["frequency_penalty"] == 0.4
        assert payload["presence_penalty"] == 0.3

    def test_streaming_shares_the_builder(self):
        payload = _llama_cpp()._build_payload(_req(frequency_penalty=0.4), stream=True)
        assert payload["frequency_penalty"] == 0.4

    def test_absent_and_zero_send_nothing(self):
        for request in (_req(), _req(frequency_penalty=0.0, presence_penalty=0.0)):
            payload = _llama_cpp()._build_payload(request, stream=False)
            for name in PENALTIES:
                assert name not in payload

    def test_repeat_penalty_is_never_synthesized(self):
        """`repeat_penalty` is a DIFFERENT knob (multiplicative, 1.0 = off)."""
        payload = _llama_cpp()._build_payload(_req(frequency_penalty=0.4), stream=False)
        assert "repeat_penalty" not in payload


# ---------------------------------------------------------------------------
# 6. Adapters that DROP — and say so, and never fail the call
# ---------------------------------------------------------------------------


def _ollama():
    from text.providers.ollama import OllamaProvider

    provider = OllamaProvider(AsyncMock(spec=httpx.AsyncClient))
    stub_endpoint(provider)
    return provider


def _anthropic():
    from text.providers.anthropic import AnthropicProvider

    return AnthropicProvider()


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


def _vertex():
    from text.providers.vertex import VertexProvider

    return VertexProvider()


def _ollama_body(request: GenerateRequest) -> dict[str, Any]:
    return _ollama()._build_payload(request, stream=False)


def _anthropic_body(request: GenerateRequest) -> dict[str, Any]:
    return _anthropic()._build_create_kwargs(request)


def _bedrock_body(request: GenerateRequest) -> dict[str, Any]:
    return _bedrock()._build_converse_params(request)


def _vertex_body(request: GenerateRequest) -> dict[str, Any]:
    return _vertex()._build_config(request).model_dump(exclude_none=True)


DROPPING = pytest.mark.parametrize(
    ("provider", "build"),
    [
        ("ollama", _ollama_body),
        ("anthropic", _anthropic_body),
        ("bedrock", _bedrock_body),
        ("vertex", _vertex_body),
    ],
    ids=["ollama", "anthropic", "bedrock", "vertex"],
)


def _all_keys(value: Any) -> set[str]:
    """Every key at any depth — a penalty must not hide in a nested block."""
    keys: set[str] = set()
    if isinstance(value, dict):
        for key, inner in value.items():
            keys.add(str(key))
            keys |= _all_keys(inner)
    elif isinstance(value, list):
        for inner in value:
            keys |= _all_keys(inner)
    return keys


# Every spelling a penalty could be smuggled out under, including the ALIAS a
# well-meaning adapter might reach for (Ollama's multiplicative `repeat_penalty`).
_FORBIDDEN = {
    "frequency_penalty",
    "presence_penalty",
    "frequencyPenalty",
    "presencePenalty",
    "repeat_penalty",
    "additionalModelRequestFields",
}


@DROPPING
class TestDroppingAdapters:
    def test_a_non_zero_penalty_is_not_on_the_wire(self, provider, build):
        body = build(_req(frequency_penalty=0.4, presence_penalty=0.3))
        assert _all_keys(body) & _FORBIDDEN == set()

    def test_the_drop_is_logged_naming_the_provider(self, provider, build, dropped):
        build(_req(frequency_penalty=0.4, presence_penalty=0.3))
        assert len(dropped) == 1
        event, fields = dropped[0]
        assert event == "text.generation.penalties_dropped"
        assert fields["provider"] == provider
        assert fields["frequency_penalty"] == 0.4
        assert fields["presence_penalty"] == 0.3

    def test_a_served_default_is_dropped_too(self, provider, build, dropped):
        from text.core.defaults import apply_generation_defaults

        apply_generation_defaults({"presence_penalty": 0.3})
        body = build(_req())
        assert _all_keys(body) & _FORBIDDEN == set()
        assert [e for e, _ in dropped] == ["text.generation.penalties_dropped"]

    def test_absent_or_zero_logs_nothing(self, provider, build, dropped):
        build(_req())
        build(_req(frequency_penalty=0.0, presence_penalty=0.0))
        assert dropped == []


class TestADropNeverFailsTheCall:
    @pytest.mark.asyncio
    async def test_bedrock_still_generates(self):
        content, _reasoning, _stats = await _bedrock().generate(
            _req(frequency_penalty=0.4, presence_penalty=0.3)
        )
        assert content == "Hello"


# ---------------------------------------------------------------------------
# 7. The helpers — one definition of "a penalty worth sending"
# ---------------------------------------------------------------------------


class TestHelpers:
    def test_penalty_kwargs_picks_only_resolved_penalties(self):
        from text.core.defaults import penalty_kwargs

        resolved = {"temperature": 0.1, "max_tokens": 10, "top_p": 0.9, "presence_penalty": 0.3}
        assert penalty_kwargs(resolved) == {"presence_penalty": 0.3}

    def test_penalty_kwargs_is_empty_without_penalties(self):
        from text.core.defaults import penalty_kwargs

        assert penalty_kwargs({"temperature": 0.1, "max_tokens": 10, "top_p": 0.9}) == {}

    def test_recording_a_drop_with_nothing_to_drop_is_silent(self, dropped):
        from text.core.defaults import record_dropped_penalties

        record_dropped_penalties({"temperature": 0.1}, provider="ollama", model="m")
        assert dropped == []

    def test_the_record_names_provider_and_model(self, dropped):
        from text.core.defaults import record_dropped_penalties

        record_dropped_penalties({"frequency_penalty": 0.4}, provider="anthropic", model="claude-x")
        event, fields = dropped[0]
        assert event == "text.generation.penalties_dropped"
        assert fields == {"provider": "anthropic", "model": "claude-x", "frequency_penalty": 0.4}
