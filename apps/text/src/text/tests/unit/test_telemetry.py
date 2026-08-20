"""TDD tests for OpenTelemetry tracing (Phase 2 — Tasks 2.1 & 2.2).

RED: Written before implementation.
Tests cover:
  - telemetry.py setup_telemetry / get_tracer
  - otel_enabled flag integration in create_app
  - GenAI semantic-convention spans on all providers
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from text.core.config import (
    AzureOpenAIConfig,
    BedrockConfig,
    Settings,
)
from text.models.requests import GenerateRequest
from text.tests.conftest import keyed

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


@pytest.fixture
def azure_config():
    return keyed(
        AzureOpenAIConfig(
            endpoint="https://test.openai.azure.com",
            deployment_name="gpt-4",
            default_model="gpt-4",
        ),
        "test-key",
    )


@pytest.fixture
def bedrock_config():
    return BedrockConfig(
        region="us-east-1",
        default_model="anthropic.claude-3-haiku-20240307-v1:0",
    )


# ---------------------------------------------------------------------------
# Task 2.1 — telemetry.py: setup_telemetry / get_tracer
# ---------------------------------------------------------------------------


class TestSetupTelemetry:
    """Tests for the setup_telemetry function."""

    def test_setup_telemetry_sets_tracer_provider(self):
        """After setup_telemetry(), the global provider must be a real TracerProvider."""
        from text.core.telemetry import setup_telemetry

        app = MagicMock()
        setup_telemetry(app, endpoint="http://localhost:4317")

        provider = trace.get_tracer_provider()
        assert isinstance(provider, TracerProvider)

    def test_setup_telemetry_uses_custom_endpoint(self):
        """setup_telemetry should accept a custom OTLP endpoint."""
        from text.core.telemetry import setup_telemetry

        app = MagicMock()
        setup_telemetry(app, endpoint="http://custom:4317")

        provider = trace.get_tracer_provider()
        assert isinstance(provider, TracerProvider)

    def test_setup_telemetry_uses_service_name(self):
        """setup_telemetry should accept and use a custom service name."""
        from text.core.telemetry import setup_telemetry

        app = MagicMock()
        setup_telemetry(app, endpoint="http://localhost:4317", service_name="my-service")

        provider = trace.get_tracer_provider()
        assert isinstance(provider, TracerProvider)
        resource_attrs = dict(provider.resource.attributes)
        assert resource_attrs["service.name"] == "my-service"


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

    def test_telemetry_not_setup_when_disabled(self):
        """When otel_enabled=False, tracer provider must remain NoOp."""
        settings = Settings(
            host="127.0.0.1",
            port=5099,
            debug=True,
            otel_enabled=False,
            metrics_enabled=False,
        )
        from text.main import create_app

        create_app(settings_override=settings)

        provider = trace.get_tracer_provider()
        assert not isinstance(provider, TracerProvider)

    def test_telemetry_setup_when_enabled(self):
        """When otel_enabled=True, create_app must call setup_opentelemetry."""
        settings = Settings(
            host="127.0.0.1",
            port=5099,
            debug=True,
            otel_enabled=True,
            metrics_enabled=False,
        )
        with patch("text.core.observability.setup_opentelemetry") as mock_setup:
            from text.main import create_app

            create_app(settings_override=settings)
            mock_setup.assert_called_once()

    def test_otel_service_name_setting_exists(self):
        """Settings declares `otel_service_name` with the default 'text'.

        Asserted against the FIELD DECLARATION, not against a constructed `Settings()`.
        `otel_service_name` is env-populatable (`OTEL_SERVICE_NAME`), so constructing an instance
        tests whatever the ambient environment holds — the loaded `.env.test` says
        `api-gateway`, and something later in a full-suite run leaves `text` behind, which is
        why this passed alone and failed in the full run. The declared default is what the test
        name and docstring have always claimed to check, and it is order-independent.
        """
        field = Settings.model_fields["otel_service_name"]
        assert field.default == "text"


# ---------------------------------------------------------------------------
# Task 2.2 — GenAI spans on providers
# ---------------------------------------------------------------------------


class TestAzureGenAISpans:
    """Azure OpenAI provider must create GenAI-attributed spans."""

    @pytest.mark.asyncio
    async def test_azure_generate_creates_span(self, in_memory_exporter, azure_config):
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

        with patch.object(AzureOpenAIProvider, "__init__", lambda self, config: None):
            provider = AzureOpenAIProvider.__new__(AzureOpenAIProvider)
            provider._config = azure_config
            provider._default_model = azure_config.default_model
            provider._client = AsyncMock()
            provider._client.chat.completions.create = AsyncMock(return_value=mock_response)

            content, _reasoning, usage = await provider.generate(GenerateRequest(prompt="hi"))

        spans = in_memory_exporter.get_finished_spans()
        gen_spans = [s for s in spans if s.attributes.get("gen_ai.system") == "azure_openai"]
        assert len(gen_spans) == 1

    @pytest.mark.asyncio
    async def test_azure_span_has_usage_attributes(self, in_memory_exporter, azure_config):
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

        with patch.object(AzureOpenAIProvider, "__init__", lambda self, config: None):
            provider = AzureOpenAIProvider.__new__(AzureOpenAIProvider)
            provider._config = azure_config
            provider._default_model = azure_config.default_model
            provider._client = AsyncMock()
            provider._client.chat.completions.create = AsyncMock(return_value=mock_response)

            await provider.generate(GenerateRequest(prompt="hi"))

        spans = in_memory_exporter.get_finished_spans()
        gen_span = next(s for s in spans if s.attributes.get("gen_ai.system") == "azure_openai")
        attrs = dict(gen_span.attributes)
        assert attrs["gen_ai.usage.input_tokens"] == 15
        assert attrs["gen_ai.usage.output_tokens"] == 20

    @pytest.mark.asyncio
    async def test_azure_streaming_creates_span(self, in_memory_exporter, azure_config):
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

        with patch.object(AzureOpenAIProvider, "__init__", lambda self, config: None):
            provider = AzureOpenAIProvider.__new__(AzureOpenAIProvider)
            provider._config = azure_config
            provider._default_model = azure_config.default_model
            provider._client = AsyncMock()
            provider._client.chat.completions.create = AsyncMock(return_value=_aiter_chunks())

            chunks = []
            async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", stream=True)):
                chunks.append(chunk)

        spans = in_memory_exporter.get_finished_spans()
        gen_spans = [s for s in spans if s.attributes.get("gen_ai.system") == "azure_openai"]
        assert len(gen_spans) == 1
        attrs = dict(gen_spans[0].attributes)
        assert attrs["gen_ai.operation.name"] == "generate_stream"


class TestBedrockGenAISpans:
    """AWS Bedrock provider must create GenAI-attributed spans."""

    @pytest.mark.asyncio
    async def test_bedrock_generate_creates_span(self, in_memory_exporter, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_boto_response = {
            "output": {"message": {"content": [{"text": "Bedrock says hi"}]}},
            "usage": {"inputTokens": 12, "outputTokens": 8},
            "stopReason": "end_turn",
        }

        with patch.object(BedrockProvider, "__init__", lambda self, config: None):
            provider = BedrockProvider.__new__(BedrockProvider)
            provider._config = bedrock_config
            provider._default_model = bedrock_config.default_model
            provider._client = MagicMock()

            async def _fake_to_thread(fn, *args, **kwargs):
                return mock_boto_response

            with patch("text.providers.bedrock.asyncio") as mock_asyncio:
                mock_asyncio.to_thread = _fake_to_thread
                content, _reasoning, usage = await provider.generate(
                    GenerateRequest(prompt="hi", model="anthropic.claude-3-haiku-20240307-v1:0")
                )

        spans = in_memory_exporter.get_finished_spans()
        gen_spans = [s for s in spans if s.attributes.get("gen_ai.system") == "aws_bedrock"]
        assert len(gen_spans) == 1

    @pytest.mark.asyncio
    async def test_bedrock_span_has_usage_attributes(self, in_memory_exporter, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_boto_response = {
            "output": {"message": {"content": [{"text": "Bedrock says hi"}]}},
            "usage": {"inputTokens": 12, "outputTokens": 8},
            "stopReason": "end_turn",
        }

        with patch.object(BedrockProvider, "__init__", lambda self, config: None):
            provider = BedrockProvider.__new__(BedrockProvider)
            provider._config = bedrock_config
            provider._default_model = bedrock_config.default_model
            provider._client = MagicMock()

            async def _fake_to_thread(fn, *args, **kwargs):
                return mock_boto_response

            with patch("text.providers.bedrock.asyncio") as mock_asyncio:
                mock_asyncio.to_thread = _fake_to_thread
                await provider.generate(
                    GenerateRequest(prompt="hi", model="anthropic.claude-3-haiku-20240307-v1:0")
                )

        spans = in_memory_exporter.get_finished_spans()
        gen_span = next(s for s in spans if s.attributes.get("gen_ai.system") == "aws_bedrock")
        attrs = dict(gen_span.attributes)
        assert attrs["gen_ai.usage.input_tokens"] == 12
        assert attrs["gen_ai.usage.output_tokens"] == 8

    @pytest.mark.asyncio
    async def test_bedrock_streaming_creates_span(self, in_memory_exporter, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        events = [
            {"contentBlockDelta": {"delta": {"text": "Hello"}}},
            {"messageStop": {"stopReason": "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 5, "outputTokens": 3}}},
        ]

        with patch.object(BedrockProvider, "__init__", lambda self, config: None):
            provider = BedrockProvider.__new__(BedrockProvider)
            provider._config = bedrock_config
            provider._default_model = bedrock_config.default_model
            mock_client = MagicMock()
            mock_client.converse_stream.return_value = {"stream": iter(events)}
            provider._client = mock_client

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
