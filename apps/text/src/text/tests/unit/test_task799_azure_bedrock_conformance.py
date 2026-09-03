"""Azure OpenAI + AWS Bedrock adapters vs. the official vendor contracts.

Every assertion below is anchored to a vendor document, cited inline. The two
adapters worked before this ticket; what they did not do was CONFORM on four
points that only show up in production:

1. **Azure content-filter annotations sit on the CHOICE, not the response root.**
   ``choices[i].content_filter_results`` is the completion-side annotation (the
   one that says the ANSWER was flagged/filtered); ``prompt_filter_results`` is
   the root-level, prompt-side one. The adapter read BOTH off the root, so the
   completion-side annotation could never be captured and a filtered answer was
   indistinguishable from an empty one.
   → https://learn.microsoft.com/azure/ai-foundry/openai/concepts/content-filter-annotations
     ("Output" — ``content_filter_results`` nested inside ``choices[0]``,
     ``prompt_filter_results`` at the root).

2. **Streaming carries the same annotations, in their own frames.** The prompt
   annotation arrives as a chunk with ``"choices": []`` plus
   ``prompt_filter_results``; completion annotations arrive as annotation
   messages whose text is empty. The adapter dropped both.
   → https://learn.microsoft.com/azure/ai-foundry/openai/concepts/content-streaming
     ("Annotations and sample responses").

3. **A stream that never delivered a terminal marker is not a clean stop.**
   Bedrock's ``messageStop`` carries a REQUIRED ``stopReason``; the OpenAI wire
   puts ``finish_reason`` on the final choice. Both adapters emitted
   ``done{finish_reason: "stop"}`` when neither ever arrived — a truncated
   answer reported, billed and audited as a complete one, while the
   ``GenerationStats`` beside it said ``"other"``.

4. **Bedrock's ``StopReason`` enum grew.** ``malformed_model_output``,
   ``malformed_tool_use`` and ``model_context_window_exceeded`` are current
   members that the normalization table did not know, so they degraded to
   ``"other"`` — and a context-window overflow is a LENGTH stop, which is what
   the metering plane needs to see.
   → botocore ``bedrock-runtime/2023-09-30/service-2.json`` shape ``StopReason``.

Plus the fail-closed floor for both, which must not regress.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from text.core.exceptions import ProviderCredentialsError
from text.models.requests import GenerateRequest
from text.models.stream import StreamChunk
from text.tests.conftest import connected, stub_client

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _azure_request(**kwargs) -> GenerateRequest:
    base = {"prompt": "hi", "provider": "azure_openai", "model": "test-deployment"}
    base.update(kwargs)
    return connected(GenerateRequest(**base), base_url="https://t.openai.azure.com")


def _bedrock_request(**kwargs) -> GenerateRequest:
    base = {"prompt": "hi", "provider": "bedrock", "model": "anthropic.claude-x-v1:0"}
    base.update(kwargs)
    return connected(GenerateRequest(**base), region="us-east-1")


def _azure_provider(create_result):
    from text.providers.azure_openai import AzureOpenAIProvider

    provider = AzureOpenAIProvider()
    client = stub_client(provider, AsyncMock())
    client.chat.completions.create = AsyncMock(return_value=create_result)
    return provider


def _bedrock_provider():
    from text.providers.bedrock import BedrockProvider

    provider = BedrockProvider()
    stub_client(provider, MagicMock())
    return provider


def _azure_completion(*, content="ok", finish_reason="stop", choice_extra=None, root_extra=None):
    """A ChatCompletion as the openai SDK hands it back.

    Built with ``construct`` because Azure's filter annotations are EXTRA fields
    on the OpenAI-typed models — the SDK's ``extra="allow"`` is exactly why
    ``getattr`` can see them, and a MagicMock would answer to any attribute name
    and therefore prove nothing about where the field actually lives.
    """
    from openai.types.chat import ChatCompletion
    from openai.types.chat.chat_completion import Choice

    choice = Choice.construct(
        index=0,
        finish_reason=finish_reason,
        message={"role": "assistant", "content": content},
        **(choice_extra or {}),
    )
    return ChatCompletion.construct(
        id="c",
        object="chat.completion",
        created=0,
        model="test-deployment",
        choices=[choice],
        usage={"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12},
        **(root_extra or {}),
    )


def _azure_chunk(*, content=None, finish_reason=None, choices=True, **extra):
    """One streamed chunk. ``choices=False`` is Azure's annotation/usage frame."""
    chunk = MagicMock()
    if choices:
        choice = MagicMock()
        choice.delta.content = content
        choice.delta.reasoning_content = None
        choice.delta.reasoning = None
        choice.finish_reason = finish_reason
        for key, value in extra.items():
            setattr(choice, key, value)
        chunk.choices = [choice]
        chunk.usage = None
    else:
        chunk.choices = []
        chunk.usage = None
        for key, value in extra.items():
            setattr(chunk, key, value)
    return chunk


async def _astream(items):
    for item in items:
        yield item


async def _collect(agen) -> list[StreamChunk]:
    return [chunk async for chunk in agen]


class _EventStream:
    """A boto3 EventStream stand-in; ``error`` raises after the listed events."""

    def __init__(self, events, *, error: Exception | None = None):
        self._events = list(events)
        self._error = error
        self._i = 0

    def __iter__(self):
        return self

    def __next__(self):
        if self._i >= len(self._events):
            if self._error is not None:
                raise self._error
            raise StopIteration
        event = self._events[self._i]
        self._i += 1
        return event


# ---------------------------------------------------------------------------
# 1 — Azure content-filter annotations, non-streaming
# ---------------------------------------------------------------------------


_CHOICE_FILTER = {
    "hate": {"filtered": False, "severity": "safe"},
    "protected_material_text": {"detected": True, "filtered": False},
}
_PROMPT_FILTER = [{"prompt_index": 0, "content_filter_results": {"jailbreak": {"detected": False}}}]


class TestAzureContentFilterAnnotationsNonStreaming:
    @pytest.mark.asyncio
    async def test_the_completion_side_annotation_is_read_off_the_choice(self):
        """``content_filter_results`` is a member of ``choices[i]``.

        Reading it off the response ROOT — where only ``prompt_filter_results``
        lives — can never find it, so a completion that Azure flagged looked
        exactly like one it did not.
        """
        provider = _azure_provider(
            _azure_completion(choice_extra={"content_filter_results": _CHOICE_FILTER})
        )

        _content, _reasoning, stats = await provider.generate(_azure_request())

        assert stats.engine_native is not None
        assert stats.engine_native["content_filter_results"] == _CHOICE_FILTER

    @pytest.mark.asyncio
    async def test_the_prompt_side_annotation_is_still_read_off_the_root(self):
        """Regression: ``prompt_filter_results`` IS a root member, and stays one."""
        provider = _azure_provider(
            _azure_completion(root_extra={"prompt_filter_results": _PROMPT_FILTER})
        )

        _content, _reasoning, stats = await provider.generate(_azure_request())

        assert stats.engine_native["prompt_filter_results"] == _PROMPT_FILTER

    @pytest.mark.asyncio
    async def test_a_filtered_completion_is_distinguishable_from_an_empty_one(self):
        """200 + ``finish_reason: content_filter`` + no content is a REFUSAL.

        Azure returns the annotation alongside it; without that blob an empty
        string is all the caller gets, and "the model said nothing" and "the
        safety system removed the answer" are the same observation.
        """
        provider = _azure_provider(
            _azure_completion(
                content=None,
                finish_reason="content_filter",
                choice_extra={
                    "content_filter_results": {"violence": {"filtered": True, "severity": "high"}}
                },
            )
        )

        content, _reasoning, stats = await provider.generate(_azure_request())

        assert content == ""
        assert stats.stop_reason == "content_filter"
        assert stats.stop_reason_raw == "content_filter"
        assert stats.engine_native["content_filter_results"]["violence"]["filtered"] is True

    @pytest.mark.asyncio
    async def test_usage_and_finish_reason_are_captured(self):
        provider = _azure_provider(_azure_completion())

        _content, _reasoning, stats = await provider.generate(_azure_request())

        assert (stats.prompt_tokens, stats.predicted_tokens, stats.total_tokens) == (5, 7, 12)
        assert stats.stop_reason == "stop"
        assert stats.engine_native["usage"]["prompt_tokens"] == 5


# ---------------------------------------------------------------------------
# 2 — Azure streaming
# ---------------------------------------------------------------------------


class TestAzureStreamingConformance:
    @pytest.mark.asyncio
    async def test_a_stream_assembles_in_order_and_terminates_with_usage_then_done(self):
        """The drained shape: content chunks, then exactly one ``usage``, then one
        ``done`` — in that order. ``stream_options={"include_usage": true}`` puts
        the usage on a FINAL choice-less chunk, so an early return on the finish
        chunk would drop it.
        → API lifecycle: ``stream_options`` & ``include_usage`` added in
          2024-08-01-preview, i.e. present on this adapter's api-version.
        """
        provider = _azure_provider(None)
        provider._client.chat.completions.create = AsyncMock(
            return_value=_astream(
                [
                    _azure_chunk(content="Hello"),
                    _azure_chunk(content=" world"),
                    _azure_chunk(content=None, finish_reason="stop"),
                    _azure_chunk(
                        choices=False,
                        usage=MagicMock(prompt_tokens=5, completion_tokens=7, total_tokens=12),
                    ),
                ]
            )
        )

        chunks = await _collect(provider.generate_stream(_azure_request(stream=True)))

        assert [c.content for c in chunks if c.type == "chunk"] == ["Hello", " world"]
        assert [c.type for c in chunks[-2:]] == ["usage", "done"]
        assert chunks[-2].data["prompt_tokens"] == 5
        assert chunks[-2].data["predicted_tokens"] == 7
        assert chunks[-1].data["finish_reason"] == "stop"

    @pytest.mark.asyncio
    async def test_the_prompt_annotation_frame_is_captured(self):
        """Azure's first streamed frame is ``{"choices": [], "prompt_filter_results": [...]}``.

        The adapter skips choice-less frames after harvesting usage; that frame
        is the ONLY place the prompt-side annotation appears on a stream.
        """
        provider = _azure_provider(None)
        provider._client.chat.completions.create = AsyncMock(
            return_value=_astream(
                [
                    _azure_chunk(choices=False, prompt_filter_results=_PROMPT_FILTER),
                    _azure_chunk(content="ok", finish_reason="stop"),
                ]
            )
        )

        chunks = await _collect(provider.generate_stream(_azure_request(stream=True)))
        usage_chunk = next(c for c in chunks if c.type == "usage")

        assert usage_chunk.data["engine_native"]["prompt_filter_results"] == _PROMPT_FILTER

    @pytest.mark.asyncio
    async def test_completion_annotation_messages_are_captured(self):
        """An annotation message has empty text and carries
        ``choices[0].content_filter_results``; several may refer to the same
        tokens, so they accumulate rather than overwrite."""
        first = {"hate": {"filtered": False, "severity": "safe"}}
        second = {"self_harm": {"filtered": True, "severity": "high"}}
        provider = _azure_provider(None)
        provider._client.chat.completions.create = AsyncMock(
            return_value=_astream(
                [
                    _azure_chunk(content="partial"),
                    _azure_chunk(content=None, content_filter_results=first),
                    _azure_chunk(
                        content=None, finish_reason="content_filter", content_filter_results=second
                    ),
                ]
            )
        )

        chunks = await _collect(provider.generate_stream(_azure_request(stream=True)))
        usage_chunk = next(c for c in chunks if c.type == "usage")

        assert usage_chunk.data["engine_native"]["content_filter_results"] == [first, second]
        assert usage_chunk.data["stop_reason"] == "content_filter"
        assert chunks[-1].data["finish_reason"] == "content_filter"

    @pytest.mark.asyncio
    async def test_a_stream_with_no_terminal_marker_is_not_reported_as_a_clean_stop(self):
        """The truncation case: tokens arrived, the connection ended, no chunk
        ever carried a ``finish_reason``.

        Substituting ``"stop"`` here turns a short/truncated answer into a
        complete one for the audit log and the ``STOP_REASON_TOTAL`` metric,
        while the ``GenerationStats`` in the very same frame says ``"other"``.
        The terminal frame must agree with the stats beside it.
        """
        provider = _azure_provider(None)
        provider._client.chat.completions.create = AsyncMock(
            return_value=_astream([_azure_chunk(content="half an ans")])
        )

        chunks = await _collect(provider.generate_stream(_azure_request(stream=True)))
        usage_chunk = next(c for c in chunks if c.type == "usage")

        assert usage_chunk.data["stop_reason"] == "other"
        assert chunks[-1].type == "done"
        assert chunks[-1].data["finish_reason"] != "stop"
        assert chunks[-1].data["finish_reason"] == usage_chunk.data["stop_reason"]

    @pytest.mark.asyncio
    async def test_a_mid_stream_error_surfaces_as_an_error_not_a_truncated_success(self):
        """Azure can fail after the first token (async content filter, model
        stream error). The exception must reach the caller, and NO terminal
        ``done`` frame may be emitted — a ``done`` is the signal the gateway
        keys a completed generation on."""

        async def _boom():
            yield _azure_chunk(content="partial")
            raise RuntimeError("connection reset")

        provider = _azure_provider(None)
        provider._client.chat.completions.create = AsyncMock(return_value=_boom())

        seen: list[StreamChunk] = []
        with pytest.raises(RuntimeError, match="connection reset"):
            async for chunk in provider.generate_stream(_azure_request(stream=True)):
                seen.append(chunk)

        assert [c.type for c in seen] == ["chunk"]
        assert not [c for c in seen if c.type in ("done", "usage")]


# ---------------------------------------------------------------------------
# 3 — Azure fail-closed floor
# ---------------------------------------------------------------------------


class TestAzureFailsClosed:
    @pytest.mark.asyncio
    async def test_no_connection_raises_the_503_contract(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        with pytest.raises(ProviderCredentialsError) as exc:
            await AzureOpenAIProvider().generate(
                GenerateRequest(prompt="hi", provider="azure_openai", model="m")
            )
        assert exc.value.error_code == "PROVIDER_CREDENTIALS_MISSING"

    @pytest.mark.asyncio
    async def test_a_connection_with_no_endpoint_raises_rather_than_building_a_broken_client(self):
        """Azure routes by ``https://<resource>.openai.azure.com`` + deployment.

        ``AsyncAzureOpenAI(azure_endpoint="")`` does NOT raise — it builds a
        client whose ``base_url`` is the relative string ``/openai/``. That
        client is unusable, and it fails much later with an error that names
        neither the tenant nor the missing row. Bedrock already refuses a
        connection with no ``region`` for exactly this reason.
        """
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider()
        request = connected(
            GenerateRequest(prompt="hi", provider="azure_openai", model="m"), base_url=None
        )

        with pytest.raises(ProviderCredentialsError) as exc:
            await provider.generate(request)
        assert exc.value.error_code == "PROVIDER_CREDENTIALS_MISSING"

    @pytest.mark.asyncio
    async def test_a_keyless_connection_raises_the_typed_error_and_never_leaks_the_key(self):
        """The SDK raises a bare ``OpenAIError`` for an empty key, which is a 500.
        It must be translated into the 503 credential contract, with no key
        material in the message — the shape ``providers/openai.py`` already uses.
        """
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider()
        request = connected(
            GenerateRequest(prompt="hi", provider="azure_openai", model="m"),
            key="",
            base_url="https://t.openai.azure.com",
        )

        with pytest.raises(ProviderCredentialsError) as exc:
            await provider.generate(request)
        assert exc.value.error_code == "PROVIDER_CREDENTIALS_MISSING"


# ---------------------------------------------------------------------------
# 4 — Bedrock stop reasons
# ---------------------------------------------------------------------------


class TestBedrockStopReasonCoverage:
    """Every member of the CURRENT ``StopReason`` enum must normalize.

    Source of truth: botocore's own service model,
    ``botocore/data/bedrock-runtime/2023-09-30/service-2.json`` shape
    ``StopReason`` — end_turn, tool_use, max_tokens, stop_sequence,
    guardrail_intervened, content_filtered, malformed_model_output,
    malformed_tool_use, model_context_window_exceeded.
    """

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("end_turn", "stop"),
            ("stop_sequence", "stop"),
            ("max_tokens", "length"),
            ("model_context_window_exceeded", "length"),
            ("content_filtered", "content_filter"),
            ("guardrail_intervened", "content_filter"),
            ("tool_use", "tool_call"),
            ("malformed_model_output", "error"),
            ("malformed_tool_use", "error"),
        ],
    )
    def test_every_current_enum_member_normalizes(self, raw, expected):
        from text.models.stats import normalize_stop_reason

        assert normalize_stop_reason("bedrock", raw) == expected

    def test_the_enum_this_asserts_against_is_the_one_botocore_ships(self):
        """Guard the guard: if AWS adds a member, this fails rather than letting
        a new stop reason quietly meter as ``other``."""
        import gzip
        import json
        from pathlib import Path

        import botocore

        model = Path(botocore.__file__).parent / (
            "data/bedrock-runtime/2023-09-30/service-2.json.gz"
        )
        if not model.exists():  # pragma: no cover — packaging variant
            pytest.skip("botocore service model not present as a .gz in this install")
        with gzip.open(model) as handle:
            shapes = json.load(handle)["shapes"]

        from text.models.stats import normalize_stop_reason

        unmapped = [
            member
            for member in shapes["StopReason"]["enum"]
            if normalize_stop_reason("bedrock", member) == "other"
        ]
        assert unmapped == []


# ---------------------------------------------------------------------------
# 5 — Bedrock streaming
# ---------------------------------------------------------------------------


class TestBedrockStreamingConformance:
    @pytest.mark.asyncio
    async def test_a_stream_assembles_in_order_and_terminates_with_usage_then_done(self):
        """``messageStop`` (stopReason) arrives BEFORE ``metadata`` (usage), so the
        adapter must drain to completion and emit usage → done, in that order."""
        provider = _bedrock_provider()
        provider._client.converse_stream.return_value = {
            "stream": _EventStream(
                [
                    {"contentBlockDelta": {"delta": {"text": "Hello"}}},
                    {"contentBlockDelta": {"delta": {"text": " world"}}},
                    {"messageStop": {"stopReason": "end_turn"}},
                    {
                        "metadata": {
                            "usage": {
                                "inputTokens": 5,
                                "outputTokens": 7,
                                "totalTokens": 12,
                                "cacheReadInputTokens": 3,
                            },
                            "metrics": {"latencyMs": 42},
                        }
                    },
                ]
            )
        }

        chunks = await _collect(provider.generate_stream(_bedrock_request(stream=True)))

        assert [c.content for c in chunks if c.type == "chunk"] == ["Hello", " world"]
        assert [c.type for c in chunks[-2:]] == ["usage", "done"]
        assert chunks[-2].data["prompt_tokens"] == 5
        assert chunks[-2].data["predicted_tokens"] == 7
        assert chunks[-2].data["total_tokens"] == 12
        # Cache counts are priced separately; the headline three cannot carry them.
        assert chunks[-2].data["engine_native"]["usage"]["cacheReadInputTokens"] == 3
        assert chunks[-1].data["finish_reason"] == "end_turn"

    @pytest.mark.asyncio
    async def test_a_stream_with_no_messageStop_is_not_reported_as_a_clean_stop(self):
        """``MessageStopEvent.stopReason`` is REQUIRED, so a stream that ends
        without one did not finish. Reporting ``"stop"`` bills and audits a
        truncated generation as a complete one."""
        provider = _bedrock_provider()
        provider._client.converse_stream.return_value = {
            "stream": _EventStream([{"contentBlockDelta": {"delta": {"text": "half"}}}])
        }

        chunks = await _collect(provider.generate_stream(_bedrock_request(stream=True)))
        usage_chunk = next(c for c in chunks if c.type == "usage")

        assert usage_chunk.data["stop_reason"] == "other"
        assert chunks[-1].type == "done"
        assert chunks[-1].data["finish_reason"] != "stop"
        assert chunks[-1].data["finish_reason"] == usage_chunk.data["stop_reason"]

    @pytest.mark.asyncio
    async def test_a_mid_stream_error_surfaces_as_an_error_not_a_truncated_success(self):
        """botocore raises ``EventStreamError`` from ``for event in stream`` when a
        modeled stream exception (``internalServerException``,
        ``throttlingException``, ``modelStreamErrorException``, …) arrives:
        ``EventStream._parse_event`` raises for any frame whose ``:message-type``
        is ``exception``. It must reach the caller, and no ``done`` may be
        emitted."""
        provider = _bedrock_provider()
        provider._client.converse_stream.return_value = {
            "stream": _EventStream(
                [{"contentBlockDelta": {"delta": {"text": "partial"}}}],
                error=RuntimeError("An error occurred (throttlingException)"),
            )
        }

        seen: list[StreamChunk] = []
        with pytest.raises(RuntimeError, match="throttlingException"):
            async for chunk in provider.generate_stream(_bedrock_request(stream=True)):
                seen.append(chunk)

        assert [c.type for c in seen] == ["chunk"]
        assert not [c for c in seen if c.type in ("done", "usage")]

    @pytest.mark.asyncio
    async def test_a_guardrail_intervention_on_the_stream_is_reported_like_the_sync_one(self):
        """``guardrail_intervened`` is a safety event, and it reaches the stream
        path through the very same ``stopReason`` field. ``generate()`` logs it;
        ``generate_stream()`` did not, so an intervention was invisible in the
        logs for exactly the calls a clinician actually watches."""
        from text.providers import bedrock as bedrock_module

        provider = _bedrock_provider()
        provider._client.converse_stream.return_value = {
            "stream": _EventStream(
                [
                    {"contentBlockDelta": {"delta": {"text": "some"}}},
                    {"messageStop": {"stopReason": "guardrail_intervened"}},
                ]
            )
        }

        with patch.object(bedrock_module.logger, "warning") as warn:
            chunks = await _collect(provider.generate_stream(_bedrock_request(stream=True)))

        assert warn.call_args is not None
        assert warn.call_args.args[0] == "bedrock.guardrail_intervened"
        usage_chunk = next(c for c in chunks if c.type == "usage")
        assert usage_chunk.data["stop_reason"] == "content_filter"
        assert chunks[-1].data["finish_reason"] == "guardrail_intervened"


class TestBedrockNonStreamingConformance:
    @pytest.mark.asyncio
    async def test_usage_stop_reason_and_reasoning_are_captured(self):
        """``ReasoningContentBlock`` (non-streaming) nests the text under
        ``reasoningText.text``; the STREAMING ``ReasoningContentBlockDelta`` has a
        flat ``text``. The two shapes are genuinely different and both are
        exercised here and above."""
        provider = _bedrock_provider()
        provider._client.converse.return_value = {
            "output": {
                "message": {
                    "content": [
                        {"reasoningContent": {"reasoningText": {"text": "thinking"}}},
                        {"text": "answer"},
                    ]
                }
            },
            "usage": {"inputTokens": 5, "outputTokens": 7, "totalTokens": 12},
            "stopReason": "max_tokens",
        }

        content, reasoning, stats = await provider.generate(_bedrock_request())

        assert content == "answer"
        assert reasoning == "thinking"
        assert stats.stop_reason == "length"
        assert stats.stop_reason_raw == "max_tokens"
        assert (stats.prompt_tokens, stats.predicted_tokens, stats.total_tokens) == (5, 7, 12)

    @pytest.mark.asyncio
    async def test_no_connection_raises_the_503_contract(self):
        from text.providers.bedrock import BedrockProvider

        with pytest.raises(ProviderCredentialsError) as exc:
            await BedrockProvider().generate(
                GenerateRequest(prompt="hi", provider="bedrock", model="m")
            )
        assert exc.value.error_code == "PROVIDER_CREDENTIALS_MISSING"
