"""shared provider-contract suite (dev/prod parity).

Parametrized over EVERY registered Text provider (LM Studio / generic
``openai_compat``, Azure OpenAI, Bedrock) with stub fakes, this suite
locks the invariants every provider MUST hold so a future production-inference
provider (e.g. ``vllm`` + ``llama_cpp``) can be added to ``ADAPTERS`` and must
pass UNCHANGED:

1. ``generate`` returns ``(content, reasoning, GenerationStats)`` with a REAL
   normalized stop reason + engine-native token counts (never the frozen
   ``"stop"``).
2. ``generate_stream`` DRAINS past the finish chunk and yields
   ``chunk* → usage(full stats) → done`` in that order (the streaming-usage
   drop is fixed).
3. ``response_format=json_schema`` passes through to the wire (or its documented
   per-engine emulation).
4. an underlying timeout is surfaced (not swallowed) to the endpoint.
5. ``_resolve_model`` honors the caller-supplied model verbatim.
6. registry key ↔ ``get_info().name`` are consistent.

The fakes are deliberately provider-shaped (OpenAI-wire objects,
Bedrock converse events) so the contract exercises each provider's REAL native
field-mapping, not a mock of it.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from text.models.requests import GenerateRequest, ResponseFormat
from text.models.stats import GenerationStats
from text.models.stream import StreamChunk
from text.tests.conftest import stub_client, stub_endpoint

# Canonical fixture values every provider fake reports — a "length"-class finish
# (proves the real stop reason is surfaced, not the frozen "stop") + exact counts.
_PROMPT_TOKENS = 7
_PREDICTED_TOKENS = 13
_TOTAL_TOKENS = 20
_SCHEMA: dict[str, Any] = {
    "title": "ClinicalNote",
    "type": "object",
    "properties": {"plan": {"type": "string"}},
}


def _req(**overrides: Any) -> GenerateRequest:
    payload: dict[str, Any] = {"prompt": "hello", "model": "caller-model"}
    payload.update(overrides)
    return GenerateRequest(**payload)


async def _aiter(items: list[Any]) -> AsyncIterator[Any]:
    for item in items:
        yield item


# ---------------------------------------------------------------------------
# OpenAI-wire fakes (LM Studio / generic openai_compat + Azure OpenAI)
# ---------------------------------------------------------------------------


def _openai_nonstream_response() -> MagicMock:
    resp = MagicMock()
    choice = MagicMock()
    choice.message.content = "Hello"
    choice.message.reasoning_content = None
    choice.message.reasoning = None
    choice.finish_reason = "length"
    resp.choices = [choice]
    resp.usage = MagicMock(
        prompt_tokens=_PROMPT_TOKENS,
        completion_tokens=_PREDICTED_TOKENS,
        total_tokens=_TOTAL_TOKENS,
    )
    resp.stats = None  # LM Studio native `stats` blob absent in this fixture
    return resp


def _openai_stream_chunks() -> list[MagicMock]:
    """REAL OpenAI-wire ordering: content deltas, then the finish chunk, then a
    trailing usage-only chunk (``choices == []``) from ``stream_options`` — the
    exact shape whose drop the frozen early-return masked."""
    c1 = MagicMock()
    c1.choices = [MagicMock()]
    c1.choices[0].delta.content = "Hello"
    c1.choices[0].delta.reasoning_content = None
    c1.choices[0].delta.reasoning = None
    c1.choices[0].finish_reason = None

    finish = MagicMock()
    finish.choices = [MagicMock()]
    finish.choices[0].delta.content = None
    finish.choices[0].delta.reasoning_content = None
    finish.choices[0].delta.reasoning = None
    finish.choices[0].finish_reason = "length"

    usage_only = MagicMock()
    usage_only.choices = []
    usage_only.usage = MagicMock(
        prompt_tokens=_PROMPT_TOKENS,
        completion_tokens=_PREDICTED_TOKENS,
        total_tokens=_TOTAL_TOKENS,
    )
    return [c1, finish, usage_only]


def _make_openai_compat() -> Any:
    from text.providers.openai_compat import OpenAICompatProvider

    provider = OpenAICompatProvider()
    provider._client = stub_client(provider, MagicMock())
    provider._client.chat.completions.create = AsyncMock()
    return provider


def _make_azure() -> Any:
    from text.providers.azure_openai import AzureOpenAIProvider

    provider = AzureOpenAIProvider()
    provider._client = stub_client(provider, AsyncMock())
    provider._client.chat.completions.create = AsyncMock()
    return provider


def _openai_set_nonstream(provider: Any) -> None:
    provider._client.chat.completions.create = AsyncMock(return_value=_openai_nonstream_response())


def _openai_set_stream(provider: Any) -> None:
    provider._client.chat.completions.create = AsyncMock(
        return_value=_aiter(_openai_stream_chunks())
    )


def _openai_set_timeout(provider: Any) -> None:
    provider._client.chat.completions.create = AsyncMock(side_effect=TimeoutError())


def _openai_captured_schema(provider: Any) -> Any:
    kwargs = provider._client.chat.completions.create.call_args.kwargs
    return kwargs["response_format"]["json_schema"]["schema"]


# ---------------------------------------------------------------------------
# Bedrock fakes (converse / converse_stream)
# ---------------------------------------------------------------------------

_BEDROCK_RESPONSE = {
    "output": {"message": {"content": [{"text": "Hello"}]}},
    "usage": {"inputTokens": _PROMPT_TOKENS, "outputTokens": _PREDICTED_TOKENS},
    "stopReason": "max_tokens",
}
_BEDROCK_STREAM_EVENTS = [
    {"contentBlockDelta": {"delta": {"text": "Hello"}}},
    {"messageStop": {"stopReason": "max_tokens"}},
    {"metadata": {"usage": {"inputTokens": _PROMPT_TOKENS, "outputTokens": _PREDICTED_TOKENS}}},
]


def _make_bedrock() -> Any:
    from text.providers.bedrock import BedrockProvider

    with patch("boto3.client"):
        provider = BedrockProvider()
    provider._client = stub_client(provider, MagicMock())
    return provider


def _bedrock_set_nonstream(provider: Any) -> None:
    provider._client.converse.return_value = _BEDROCK_RESPONSE


def _bedrock_set_stream(provider: Any) -> None:
    provider._client.converse_stream.return_value = {"stream": iter(_BEDROCK_STREAM_EVENTS)}


def _bedrock_set_timeout(provider: Any) -> None:
    provider._client.converse.side_effect = TimeoutError()


def _bedrock_captured_schema(provider: Any) -> Any:
    kwargs = provider._client.converse.call_args.kwargs
    return kwargs["toolConfig"]["tools"][0]["toolSpec"]["inputSchema"]["json"]


# ---------------------------------------------------------------------------
# vLLM fakes — OpenAI-wire client, so it reuses the OpenAI-wire
# fakes/stubs above; only the construction differs (its own config prefix +
# engine identity ``provider="vllm"``).
# ---------------------------------------------------------------------------


def _make_vllm() -> Any:
    from text.providers.vllm import VllmProvider

    provider = VllmProvider()
    stub_endpoint(provider)
    provider._client = stub_client(provider, MagicMock())
    provider._client.chat.completions.create = AsyncMock()
    return provider


# ---------------------------------------------------------------------------
# llama.cpp fakes — native ``/completion`` over httpx (richer than
# the OpenAI shim): ``timings`` block + ``stopped_*`` flags → exact stats.
# This engine is the REFERENCE for the owner's metric names.
# ---------------------------------------------------------------------------

# Final ``/completion`` object: a length-class finish (``stopped_limit``) with
# an exact ``timings`` block. ``predicted_per_second`` (12.9) is deliberately
# NOT equal to the naive client compute (predicted_n / predicted_ms = 13.0) so
# the passthrough-vs-computed divergence test has something to assert.
_LLAMA_CPP_DONE: dict[str, Any] = {
    "content": "",
    "stop": True,
    "stopped_eos": False,
    "stopped_word": False,
    "stopped_limit": True,
    "stopping_word": "",
    "tokens_predicted": _PREDICTED_TOKENS,
    "tokens_evaluated": _PROMPT_TOKENS,
    "timings": {
        "prompt_n": _PROMPT_TOKENS,
        "predicted_n": _PREDICTED_TOKENS,
        "prompt_ms": 40.0,
        "predicted_ms": 1000.0,
        "predicted_per_second": 12.9,
        "prompt_per_second": 175.0,
    },
}


def _make_llama_cpp() -> Any:
    from text.providers.llama_cpp import LlamaCppProvider

    provider = LlamaCppProvider(AsyncMock())
    stub_endpoint(provider, "http://localhost:8080")
    return provider


def _llama_cpp_set_nonstream(provider: Any) -> None:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {**_LLAMA_CPP_DONE, "content": "Hello"}
    provider._http.post = AsyncMock(return_value=resp)


def _llama_cpp_set_stream(provider: Any) -> None:
    import json

    lines = [
        "data: " + json.dumps({"content": "Hello", "stop": False}),
        "data: " + json.dumps(_LLAMA_CPP_DONE),
    ]
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.aiter_lines = lambda: _aiter(lines)

    @asynccontextmanager
    async def _stream(*_a: Any, **_kw: Any) -> AsyncIterator[Any]:
        yield resp

    provider._http.stream = _stream


def _llama_cpp_set_timeout(provider: Any) -> None:
    provider._http.post = AsyncMock(side_effect=TimeoutError())


def _llama_cpp_captured_schema(provider: Any) -> Any:
    return provider._http.post.call_args.kwargs["json"]["json_schema"]


# ---------------------------------------------------------------------------
# Adapter registry (add vllm / llama-cpp here /514 — must pass as-is)
# ---------------------------------------------------------------------------


@dataclass
class ProviderAdapter:
    id: str
    info_name: str
    make: Callable[[], Any]
    set_nonstream: Callable[[Any], None]
    set_stream: Callable[[Any], None]
    set_timeout: Callable[[Any], None]
    captured_schema: Callable[[Any], Any]


ADAPTERS: list[ProviderAdapter] = [
    ProviderAdapter(
        id="openai_compat",
        info_name="openai_compat",
        make=_make_openai_compat,
        set_nonstream=_openai_set_nonstream,
        set_stream=_openai_set_stream,
        set_timeout=_openai_set_timeout,
        captured_schema=_openai_captured_schema,
    ),
    ProviderAdapter(
        id="azure-openai",
        info_name="azure_openai",
        make=_make_azure,
        set_nonstream=_openai_set_nonstream,
        set_stream=_openai_set_stream,
        set_timeout=_openai_set_timeout,
        captured_schema=_openai_captured_schema,
    ),
    ProviderAdapter(
        id="bedrock",
        info_name="bedrock",
        make=_make_bedrock,
        set_nonstream=_bedrock_set_nonstream,
        set_stream=_bedrock_set_stream,
        set_timeout=_bedrock_set_timeout,
        captured_schema=_bedrock_captured_schema,
    ),
    ProviderAdapter(
        id="vllm",
        info_name="vllm",
        make=_make_vllm,
        set_nonstream=_openai_set_nonstream,
        set_stream=_openai_set_stream,
        set_timeout=_openai_set_timeout,
        captured_schema=_openai_captured_schema,
    ),
    ProviderAdapter(
        id="llama-cpp",
        info_name="llama-cpp",
        make=_make_llama_cpp,
        set_nonstream=_llama_cpp_set_nonstream,
        set_stream=_llama_cpp_set_stream,
        set_timeout=_llama_cpp_set_timeout,
        captured_schema=_llama_cpp_captured_schema,
    ),
]

_IDS = [a.id for a in ADAPTERS]


@pytest.mark.parametrize("adapter", ADAPTERS, ids=_IDS)
class TestProviderContract:
    @pytest.mark.asyncio
    async def test_generate_returns_content_and_populated_stats(self, adapter: ProviderAdapter):
        provider = adapter.make()
        adapter.set_nonstream(provider)

        content, reasoning, stats = await provider.generate(_req())

        assert content == "Hello"
        assert isinstance(reasoning, str)
        assert isinstance(stats, GenerationStats)
        # REAL stop reason — NOT the frozen "stop" (all fakes report a length-class finish).
        assert stats.stop_reason == "length"
        assert stats.stop_reason_raw
        assert stats.prompt_tokens == _PROMPT_TOKENS
        assert stats.predicted_tokens == _PREDICTED_TOKENS
        assert stats.total_tokens == _TOTAL_TOKENS
        assert stats.model == "caller-model"
        assert stats.provider  # non-empty engine identity

    @pytest.mark.asyncio
    async def test_generate_stream_drains_chunk_then_usage_then_done(
        self, adapter: ProviderAdapter
    ):
        provider = adapter.make()
        adapter.set_stream(provider)

        chunks: list[StreamChunk] = []
        async for chunk in provider.generate_stream(_req(stream=True)):
            chunks.append(chunk)

        types = [c.type for c in chunks]
        assert types.count("usage") == 1, types
        assert types.count("done") == 1, types
        usage_idx = types.index("usage")
        done_idx = types.index("done")
        # ordering: at least one content chunk, THEN usage, THEN done as the last event.
        assert any(t == "chunk" for t in types[:usage_idx]), types
        assert usage_idx < done_idx
        assert done_idx == len(types) - 1, types

        usage_data = chunks[usage_idx].data or {}
        # the usage chunk carries the FULL stats dict (predicted_tokens, not
        # a bare completion_tokens) — the streaming drop is fixed.
        assert usage_data.get("predicted_tokens") == _PREDICTED_TOKENS
        assert usage_data.get("total_tokens") == _TOTAL_TOKENS
        assert "stop_reason" in usage_data

    @pytest.mark.asyncio
    async def test_response_format_json_schema_passes_through(self, adapter: ProviderAdapter):
        provider = adapter.make()
        adapter.set_nonstream(provider)

        await provider.generate(
            _req(
                response_format=ResponseFormat(type="json_schema", json_schema=_SCHEMA, strict=True)
            )
        )
        assert adapter.captured_schema(provider) == _SCHEMA

    @pytest.mark.asyncio
    async def test_timeout_is_surfaced_not_swallowed(self, adapter: ProviderAdapter):
        provider = adapter.make()
        adapter.set_timeout(provider)

        with pytest.raises(TimeoutError):
            await provider.generate(_req())

    def test_resolve_model_honors_caller_model(self, adapter: ProviderAdapter):
        provider = adapter.make()
        assert provider._resolve_model(_req(model="caller-model")) == "caller-model"

    @pytest.mark.asyncio
    async def test_registry_key_and_get_info_are_consistent(self, adapter: ProviderAdapter):
        provider = adapter.make()
        info = await provider.get_info()
        assert info.name == adapter.info_name
        assert info.supports_streaming is True


# ---------------------------------------------------------------------------
# llama.cpp reference-engine specifics — the native ``/completion``
# ``timings`` block is the source of truth for the owner-named metrics, so it
# gets extra assertions the OpenAI-wire providers cannot make.
# ---------------------------------------------------------------------------


class TestLlamaCppReferenceEngine:
    @pytest.mark.asyncio
    async def test_engine_native_tokens_per_second_is_passthrough_not_recomputed(self):
        """``timings.predicted_per_second`` is used VERBATIM (engine-preferred),
        and the client-computed fallback only *validates* it stays within a small
        tolerance — it never overwrites the engine number."""
        provider = _make_llama_cpp()
        _llama_cpp_set_nonstream(provider)

        _content, _reasoning, stats = await provider.generate(_req())

        engine_tps = _LLAMA_CPP_DONE["timings"]["predicted_per_second"]  # 12.9
        client_tps = _PREDICTED_TOKENS / (
            _LLAMA_CPP_DONE["timings"]["predicted_ms"] / 1000.0
        )  # 13.0
        # passthrough: the engine value is used verbatim, NOT the client recompute.
        assert stats.tokens_per_second == pytest.approx(engine_tps)
        assert stats.tokens_per_second != pytest.approx(client_tps)
        # divergence between engine-reported and client-computed stays < tolerance.
        assert abs(stats.tokens_per_second - client_tps) < 0.5
        # the raw timings blob is preserved for audit.
        assert stats.engine_native is not None
        assert stats.engine_native["timings"]["predicted_per_second"] == engine_tps

    @pytest.mark.asyncio
    async def test_gbnf_grammar_passes_through_verbatim(self):
        provider = _make_llama_cpp()
        _llama_cpp_set_nonstream(provider)
        gbnf = 'root ::= "yes" | "no"'

        await provider.generate(_req(context={"grammar": gbnf}))

        payload = provider._http.post.call_args.kwargs["json"]
        assert payload["grammar"] == gbnf
        # grammar takes precedence — no JSON-schema conversion is attempted.
        assert "json_schema" not in payload

    @pytest.mark.asyncio
    async def test_json_schema_passes_through_as_native_field(self):
        provider = _make_llama_cpp()
        _llama_cpp_set_nonstream(provider)

        await provider.generate(
            _req(
                response_format=ResponseFormat(type="json_schema", json_schema=_SCHEMA, strict=True)
            )
        )
        assert provider._http.post.call_args.kwargs["json"]["json_schema"] == _SCHEMA

    @pytest.mark.parametrize(
        ("flags", "expected"),
        [
            ({"stopped_limit": True}, "length"),
            ({"stopped_eos": True}, "stop"),
            ({"stopped_word": True, "stopping_word": "STOP"}, "stop"),
        ],
    )
    @pytest.mark.asyncio
    async def test_stop_reason_mapping(self, flags: dict[str, Any], expected: str):
        provider = _make_llama_cpp()
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        base = {
            "content": "Hello",
            "stop": True,
            "stopped_eos": False,
            "stopped_word": False,
            "stopped_limit": False,
            "stopping_word": "",
            "timings": {"prompt_n": _PROMPT_TOKENS, "predicted_n": _PREDICTED_TOKENS},
        }
        base.update(flags)
        resp.json.return_value = base
        provider._http.post = AsyncMock(return_value=resp)

        _content, _reasoning, stats = await provider.generate(_req())
        assert stats.stop_reason == expected
