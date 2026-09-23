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
  parameter, and DROPPED — with a WARNING naming the provider, once per
  ``(provider, penalty)`` per process, never an error — by one whose engine
  does not.
* ORIGIN decides reach. A penalty the REQUEST carried (an agent's value, checked
  at publish against that model) is sent by every supporting adapter. A penalty
  from the PLATFORM default was chosen without knowing the model, so only the
  self-hosted OpenAI-compatible engines send it; `openai` / `azure_openai` drop
  it, because a GPT-5-class deployment refuses penalties with a 400.

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


@pytest.fixture(autouse=True)
def _fresh_drop_warnings(monkeypatch):
    """The warn-once memory is PROCESS state; each test starts with none, so an
    earlier test's drop cannot silence this one's."""
    monkeypatch.setattr("text.core.defaults._WARNED_DROPS", set())


@pytest.fixture
def dropped(monkeypatch) -> list[tuple[str, dict[str, Any]]]:
    """Every warning the penalty-drop path made.

    structlog is not wired into stdlib logging here, so the suite's house
    pattern is to patch the module logger rather than reach for ``caplog``.
    """
    calls: list[tuple[str, dict[str, Any]]] = []

    class _Recorder:
        def warning(self, event: str, **kw: Any) -> None:
            calls.append((event, kw))

    monkeypatch.setattr("text.core.defaults.logger", _Recorder())
    return calls


DROP_EVENT = "text.generation.penalty_dropped"


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

# The self-hosted OpenAI-compatible engines — the ONLY adapters on this wire that
# may send a PLATFORM-default penalty.
SELF_HOSTED_WIRE = pytest.mark.parametrize(
    "factory",
    [_make_lmstudio, _make_compat, _make_vllm],
    ids=["lmstudio", "openai_compat", "vllm"],
)

# Managed endpoints: a request-authored penalty is sent, a platform default is not.
MANAGED_WIRE = pytest.mark.parametrize(
    ("factory", "identity"),
    [(_make_openai, "openai"), (_make_azure, "azure_openai")],
    ids=["openai", "azure_openai"],
)


@OPENAI_WIRE
class TestRequestAuthoredPenaltyIsForwarded:
    """ORIGIN = request: every adapter on this wire sends it."""

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
    async def test_a_request_value_is_sent_even_over_a_platform_default(self, factory):
        from text.core.defaults import apply_generation_defaults

        apply_generation_defaults({"frequency_penalty": 0.5})
        body = await _generate_body(factory, frequency_penalty=0.2)
        assert body["frequency_penalty"] == 0.2

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

    @pytest.mark.asyncio
    async def test_forwarding_a_request_value_warns_nothing(self, factory, dropped):
        await _generate_body(factory, frequency_penalty=0.4)
        assert dropped == []


@SELF_HOSTED_WIRE
class TestPlatformDefaultReachesSelfHostedEngines:
    """ORIGIN = platform default, adapter allow-listed: sent."""

    @pytest.mark.asyncio
    async def test_generate_sends_the_platform_default(self, factory, dropped):
        from text.core.defaults import apply_generation_defaults

        apply_generation_defaults({"frequency_penalty": 0.25})
        body = await _generate_body(factory)
        assert body["frequency_penalty"] == 0.25
        assert "presence_penalty" not in body
        assert dropped == []

    @pytest.mark.asyncio
    async def test_streaming_sends_the_platform_default(self, factory):
        from text.core.defaults import apply_generation_defaults

        apply_generation_defaults({"presence_penalty": 0.3})
        body = await _stream_body(factory)
        assert body["presence_penalty"] == 0.3


@MANAGED_WIRE
class TestPlatformDefaultNeverReachesManagedEndpoints:
    """ORIGIN = platform default, adapter NOT allow-listed: withheld and warned.

    A GPT-5-class Azure/OpenAI deployment refuses penalties with a 400, so one
    admin setting that reached these adapters would break every call to them.
    """

    @pytest.mark.asyncio
    async def test_generate_withholds_the_platform_default(self, factory, identity, dropped):
        from text.core.defaults import apply_generation_defaults

        apply_generation_defaults({"frequency_penalty": 0.25, "presence_penalty": 0.3})
        body = await _generate_body(factory)
        for name in PENALTIES:
            assert name not in body
        assert {(f["provider"], f["penalty"], f["reason"]) for _, f in dropped} == {
            (identity, "frequency_penalty", "platform_default_not_forwarded"),
            (identity, "presence_penalty", "platform_default_not_forwarded"),
        }

    @pytest.mark.asyncio
    async def test_streaming_withholds_it_too(self, factory, identity):
        from text.core.defaults import apply_generation_defaults

        apply_generation_defaults({"frequency_penalty": 0.25})
        body = await _stream_body(factory)
        assert "frequency_penalty" not in body

    @pytest.mark.asyncio
    async def test_mixed_origins_send_only_the_request_value(self, factory, identity, dropped):
        from text.core.defaults import apply_generation_defaults

        apply_generation_defaults({"presence_penalty": 0.3})
        body = await _generate_body(factory, frequency_penalty=0.2)
        assert body["frequency_penalty"] == 0.2
        assert "presence_penalty" not in body
        assert [(f["penalty"], f["reason"]) for _, f in dropped] == [
            ("presence_penalty", "platform_default_not_forwarded")
        ]

    @pytest.mark.asyncio
    async def test_the_call_still_succeeds(self, factory, identity):
        from text.core.defaults import apply_generation_defaults

        apply_generation_defaults({"frequency_penalty": 0.25})
        provider = _openai_wire(factory)
        content, _reasoning, _stats = await provider.generate(_req())
        assert content == "Hello"


class TestThePlatformDefaultAllowList:
    def test_it_is_exactly_the_self_hosted_openai_compatible_engines(self):
        from text.core.defaults import PLATFORM_DEFAULT_PENALTY_PROVIDERS

        assert {"lm-studio", "openai_compat", "vllm", "llama-cpp"} == set(
            PLATFORM_DEFAULT_PENALTY_PROVIDERS
        )

    def test_it_names_the_identities_the_adapters_actually_report(self):
        """The list is keyed by the identity an adapter passes as ``provider=``;
        a spelling drift here would silently withhold the default."""
        from text.core.defaults import PLATFORM_DEFAULT_PENALTY_PROVIDERS
        from text.providers import llama_cpp

        reported = {
            _make_lmstudio()._provider_name,
            _make_compat()._provider_name,
            _make_vllm()._provider_name,
            llama_cpp._ENGINE,
        }
        assert reported == set(PLATFORM_DEFAULT_PENALTY_PROVIDERS)

    def test_managed_endpoints_are_not_on_it(self):
        from text.core.defaults import PLATFORM_DEFAULT_PENALTY_PROVIDERS

        for managed in ("openai", "azure_openai", "anthropic", "bedrock", "vertex", "ollama"):
            assert managed not in PLATFORM_DEFAULT_PENALTY_PROVIDERS


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

    def test_a_platform_default_is_sent_too(self, dropped):
        from text.core.defaults import apply_generation_defaults

        apply_generation_defaults({"frequency_penalty": 0.25})
        payload = _llama_cpp()._build_payload(_req(), stream=False)
        assert payload["frequency_penalty"] == 0.25
        assert dropped == []

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
    """Both origins are dropped here — the engine cannot take a penalty at all."""

    def test_a_request_authored_penalty_is_not_on_the_wire(self, provider, build):
        body = build(_req(frequency_penalty=0.4, presence_penalty=0.3))
        assert _all_keys(body) & _FORBIDDEN == set()

    def test_a_platform_default_is_not_on_the_wire(self, provider, build):
        from text.core.defaults import apply_generation_defaults

        apply_generation_defaults({"frequency_penalty": 0.4, "presence_penalty": 0.3})
        body = build(_req())
        assert _all_keys(body) & _FORBIDDEN == set()

    def test_the_drop_is_warned_per_penalty_naming_the_provider(self, provider, build, dropped):
        build(_req(frequency_penalty=0.4, presence_penalty=0.3))
        assert {e for e, _ in dropped} == {DROP_EVENT}
        assert {(f["provider"], f["penalty"], f["value"], f["reason"]) for _, f in dropped} == {
            (provider, "frequency_penalty", 0.4, "engine_cannot_take_penalty"),
            (provider, "presence_penalty", 0.3, "engine_cannot_take_penalty"),
        }

    def test_the_warning_fires_once_per_provider_and_penalty(self, provider, build, dropped):
        for _ in range(3):
            build(_req(frequency_penalty=0.4, presence_penalty=0.3))
        assert len(dropped) == 2

    def test_absent_or_zero_warns_nothing(self, provider, build, dropped):
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
        request = _req(presence_penalty=0.3)
        assert penalty_kwargs(resolved, request, provider="openai", model="m") == {
            "presence_penalty": 0.3
        }

    def test_penalty_kwargs_is_empty_without_penalties(self):
        from text.core.defaults import penalty_kwargs

        resolved = {"temperature": 0.1, "max_tokens": 10, "top_p": 0.9}
        assert penalty_kwargs(resolved, _req(), provider="lm-studio", model="m") == {}

    def test_origin_is_read_off_the_request(self, dropped):
        """A resolved penalty with no request value came from the platform default."""
        from text.core.defaults import penalty_kwargs

        resolved = {"frequency_penalty": 0.4}
        platform_on_managed = penalty_kwargs(resolved, _req(), provider="openai", model="m")
        platform_on_self_hosted = penalty_kwargs(resolved, _req(), provider="lm-studio", model="m")
        request = _req(frequency_penalty=0.4)
        authored = penalty_kwargs(resolved, request, provider="openai", model="m")
        assert platform_on_managed == {}
        assert platform_on_self_hosted == {"frequency_penalty": 0.4}
        assert authored == {"frequency_penalty": 0.4}

    def test_recording_a_drop_with_nothing_to_drop_is_silent(self, dropped):
        from text.core.defaults import record_dropped_penalties

        record_dropped_penalties({"temperature": 0.1}, provider="ollama", model="m")
        assert dropped == []

    def test_the_warning_names_provider_model_penalty_value_and_reason(self, dropped):
        from text.core.defaults import record_dropped_penalties

        record_dropped_penalties({"frequency_penalty": 0.4}, provider="anthropic", model="claude-x")
        assert dropped == [
            (
                DROP_EVENT,
                {
                    "provider": "anthropic",
                    "model": "claude-x",
                    "penalty": "frequency_penalty",
                    "value": 0.4,
                    "reason": "engine_cannot_take_penalty",
                },
            )
        ]

    def test_warn_once_is_keyed_by_provider_and_penalty(self, dropped):
        from text.core.defaults import record_dropped_penalties

        record_dropped_penalties({"frequency_penalty": 0.4}, provider="ollama", model="a")
        record_dropped_penalties({"frequency_penalty": 0.9}, provider="ollama", model="b")
        record_dropped_penalties({"presence_penalty": 0.4}, provider="ollama", model="a")
        record_dropped_penalties({"frequency_penalty": 0.4}, provider="bedrock", model="a")
        assert [(f["provider"], f["penalty"]) for _, f in dropped] == [
            ("ollama", "frequency_penalty"),
            ("ollama", "presence_penalty"),
            ("bedrock", "frequency_penalty"),
        ]
