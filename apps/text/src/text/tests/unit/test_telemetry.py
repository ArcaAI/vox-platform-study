"""TDD tests for OpenTelemetry tracing (Phase 2 — Tasks 2.1 & 2.2).

Tests cover:
  - telemetry.py get_tracer (the `hope_obs.get_tracer` compat wrapper — setup
    itself moved to `hope_obs`/`text.main._build_observability_config`,
    covered in `test_observability.py`; TASK-987)
  - otel_enabled flag integration in create_app
  - GenAI semantic-convention spans on all providers
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from text.core.config import Settings
from text.models.requests import GenerateRequest
from text.tests.conftest import stub_client

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _force_reset_otel():
    """Force-reset OTel global state so each test gets a clean provider."""
    import opentelemetry.trace as _trace_mod

    _trace_mod._TRACER_PROVIDER = None
    _trace_mod._TRACER_PROVIDER_SET_ONCE._done = False
    _trace_mod._PROXY_TRACER_PROVIDER._real_tracer_provider = None


@pytest.fixture(autouse=True)
def reset_tracer():
    """Reset global tracer provider before and after every test."""
    _force_reset_otel()
    yield
    _force_reset_otel()


@pytest.fixture
def in_memory_exporter():
    """Set up an in-memory span exporter so tests can inspect finished spans."""
    _force_reset_otel()
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    return exporter


# ---------------------------------------------------------------------------
# Task 2.1 — telemetry.py: get_tracer (setup moved to hope_obs, TASK-987)
# ---------------------------------------------------------------------------


class TestGetTracer:
    """Tests for the get_tracer helper."""

    def test_get_tracer_returns_tracer(self):
        """get_tracer() must return a valid Tracer object."""
        from text.core.telemetry import get_tracer

        tracer = get_tracer()
        assert tracer is not None
        assert hasattr(tracer, "start_as_current_span")
        assert hasattr(tracer, "start_span")

    def test_get_tracer_accepts_custom_name(self):
        """get_tracer('custom') should work without error."""
        from text.core.telemetry import get_tracer

        tracer = get_tracer("custom_module")
        assert tracer is not None


# ---------------------------------------------------------------------------
# Task 2.1 — otel_enabled flag integration in create_app
# ---------------------------------------------------------------------------


class TestOtelEnabledFlag:
    """Tests for the otel_enabled config flag in create_app."""

    def test_telemetry_not_setup_without_a_collector(self):
        """No collector address ⇒ export is off and the tracer stays NoOp."""
        settings = Settings(port=5099, otel_exporter_endpoint="")
        from text.main import create_app

        create_app(settings_override=settings)

        provider = trace.get_tracer_provider()
        assert not isinstance(provider, TracerProvider)

    # `test_telemetry_setup_when_a_collector_is_configured` moved to
    # `test_observability.py::TestCreateAppObservability` — that is now where
    # `create_app`'s `hope_obs` wiring is asserted (TASK-987).

    def test_otel_service_name_is_a_constant_not_a_setting(self):
        """The service cannot be told what it is by its environment.

        This used to assert a FIELD DEFAULT because the value was env-populatable
        and therefore order-dependent under a full-suite run — the loaded
        `.env.test` says `api-gateway`. A process's own identity is not
        configuration; it is derived, so there is nothing left to leak into.
        """
        assert "otel_service_name" not in Settings.model_fields
        assert Settings(port=5099).otel_service_name == "text"


# ---------------------------------------------------------------------------
# Task 2.2 — GenAI spans on providers
# ---------------------------------------------------------------------------


class TestAzureGenAISpans:
    """Azure OpenAI provider must create GenAI-attributed spans."""

    @pytest.mark.asyncio
    async def test_azure_generate_creates_span(self, in_memory_exporter):
        from text.providers.azure_openai import AzureOpenAIProvider

        mock_usage = MagicMock()
        mock_usage.prompt_tokens = 15
        mock_usage.completion_tokens = 20
        mock_usage.total_tokens = 35

        mock_choice = MagicMock()
        mock_choice.message.content = "Azure says hi"
        mock_choice.finish_reason = "stop"

        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        mock_response.usage = mock_usage

        if True:
            provider = AzureOpenAIProvider()
            provider._client = stub_client(provider, AsyncMock())
            provider._client.chat.completions.create = AsyncMock(return_value=mock_response)

            content, _reasoning, usage = await provider.generate(
                GenerateRequest(prompt="hi", model="test-model")
            )

        spans = in_memory_exporter.get_finished_spans()
        gen_spans = [s for s in spans if s.attributes.get("gen_ai.system") == "azure_openai"]
        assert len(gen_spans) == 1

    @pytest.mark.asyncio
    async def test_azure_span_has_usage_attributes(self, in_memory_exporter):
        from text.providers.azure_openai import AzureOpenAIProvider

        mock_usage = MagicMock()
        mock_usage.prompt_tokens = 15
        mock_usage.completion_tokens = 20
        mock_usage.total_tokens = 35

        mock_choice = MagicMock()
        mock_choice.message.content = "Azure says hi"
        mock_choice.finish_reason = "stop"

        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        mock_response.usage = mock_usage

        if True:
            provider = AzureOpenAIProvider()
            provider._client = stub_client(provider, AsyncMock())
            provider._client.chat.completions.create = AsyncMock(return_value=mock_response)

            await provider.generate(GenerateRequest(prompt="hi", model="test-model"))

        spans = in_memory_exporter.get_finished_spans()
        gen_span = next(s for s in spans if s.attributes.get("gen_ai.system") == "azure_openai")
        attrs = dict(gen_span.attributes)
        assert attrs["gen_ai.usage.input_tokens"] == 15
        assert attrs["gen_ai.usage.output_tokens"] == 20

    @pytest.mark.asyncio
    async def test_azure_streaming_creates_span(self, in_memory_exporter):
        from text.providers.azure_openai import AzureOpenAIProvider

        mock_delta = MagicMock()
        mock_delta.content = "streamed"
        mock_choice = MagicMock()
        mock_choice.delta = mock_delta
        mock_choice.finish_reason = "stop"

        mock_chunk = MagicMock()
        mock_chunk.choices = [mock_choice]

        async def _aiter_chunks():
            yield mock_chunk

        if True:
            provider = AzureOpenAIProvider()
            provider._client = stub_client(provider, AsyncMock())
            provider._client.chat.completions.create = AsyncMock(return_value=_aiter_chunks())

            chunks = []
            async for chunk in provider.generate_stream(
                GenerateRequest(prompt="hi", stream=True, model="test-model")
            ):
                chunks.append(chunk)

        spans = in_memory_exporter.get_finished_spans()
        gen_spans = [s for s in spans if s.attributes.get("gen_ai.system") == "azure_openai"]
        assert len(gen_spans) == 1
        attrs = dict(gen_spans[0].attributes)
        assert attrs["gen_ai.operation.name"] == "generate_stream"


class TestBedrockGenAISpans:
    """AWS Bedrock provider must create GenAI-attributed spans."""

    @pytest.mark.asyncio
    async def test_bedrock_generate_creates_span(self, in_memory_exporter):
        from text.providers.bedrock import BedrockProvider

        mock_boto_response = {
            "output": {"message": {"content": [{"text": "Bedrock says hi"}]}},
            "usage": {"inputTokens": 12, "outputTokens": 8},
            "stopReason": "end_turn",
        }

        # Stub the SDK CALL, not asyncio. This used to patch
        # `text.providers.bedrock.asyncio` wholesale and swap in a fake
        # `to_thread`, which coupled a span-attribute test to the precise
        # mechanism by which the adapter offloads blocking work.
        # changed that mechanism (`asyncio.to_thread` runs on the DEFAULT
        # executor, which a Bedrock generation holds for seconds - B-3), so the
        # test now stubs the boto3 client it is actually standing in for and no
        # longer cares which threads the call runs on.
        provider = BedrockProvider()
        provider._client = stub_client(provider, MagicMock())
        provider._client.converse.return_value = mock_boto_response

        content, _reasoning, usage = await provider.generate(
            GenerateRequest(prompt="hi", model="anthropic.claude-3-haiku-20240307-v1:0")
        )

        spans = in_memory_exporter.get_finished_spans()
        gen_spans = [s for s in spans if s.attributes.get("gen_ai.system") == "aws_bedrock"]
        assert len(gen_spans) == 1

    @pytest.mark.asyncio
    async def test_bedrock_span_has_usage_attributes(self, in_memory_exporter):
        from text.providers.bedrock import BedrockProvider

        mock_boto_response = {
            "output": {"message": {"content": [{"text": "Bedrock says hi"}]}},
            "usage": {"inputTokens": 12, "outputTokens": 8},
            "stopReason": "end_turn",
        }

        # Stub the SDK call, not asyncio - see the sibling test above.
        provider = BedrockProvider()
        provider._client = stub_client(provider, MagicMock())
        provider._client.converse.return_value = mock_boto_response

        await provider.generate(
            GenerateRequest(prompt="hi", model="anthropic.claude-3-haiku-20240307-v1:0")
        )

        spans = in_memory_exporter.get_finished_spans()
        gen_span = next(s for s in spans if s.attributes.get("gen_ai.system") == "aws_bedrock")
        attrs = dict(gen_span.attributes)
        assert attrs["gen_ai.usage.input_tokens"] == 12
        assert attrs["gen_ai.usage.output_tokens"] == 8

    @pytest.mark.asyncio
    async def test_bedrock_streaming_creates_span(self, in_memory_exporter):
        from text.providers.bedrock import BedrockProvider

        events = [
            {"contentBlockDelta": {"delta": {"text": "Hello"}}},
            {"messageStop": {"stopReason": "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 5, "outputTokens": 3}}},
        ]

        if True:
            provider = BedrockProvider()
            mock_client = MagicMock()
            mock_client.converse_stream.return_value = {"stream": iter(events)}
            provider._client = stub_client(provider, mock_client)

            chunks = []
            async for chunk in provider.generate_stream(
                GenerateRequest(
                    prompt="hi", stream=True, model="anthropic.claude-3-haiku-20240307-v1:0"
                )
            ):
                chunks.append(chunk)

        spans = in_memory_exporter.get_finished_spans()
        gen_spans = [s for s in spans if s.attributes.get("gen_ai.system") == "aws_bedrock"]
        assert len(gen_spans) == 1
        attrs = dict(gen_spans[0].attributes)
        assert attrs["gen_ai.operation.name"] == "generate_stream"
