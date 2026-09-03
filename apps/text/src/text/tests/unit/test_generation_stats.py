"""GenerationStats contract (AD-1).

RED-first TDD: these tests define the normalized per-call generation-stats
contract (``text.models.stats``) and its threading into the /generate
response. Every provider's native stop-reason / token / timing fields must map
into the single ``GenerationStats`` shape, and a stats failure must NEVER fail
an otherwise-successful generation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.models.requests import GenerateRequest
from text.models.stream import StreamChunk
from text.tests.conftest import stub_client

# ---------------------------------------------------------------------------
# GenerationStats model + AD-1 field shape
# ---------------------------------------------------------------------------


class TestGenerationStatsShape:
    def test_ad1_fields_exist_with_expected_types(self):
        from text.models.stats import GenerationStats

        stats = GenerationStats(
            stop_reason="stop",
            stop_reason_raw="end_turn",
            total_ms=1234,
            ttft_ms=42,
            tokens_per_second=12.5,
            prompt_tokens=10,
            predicted_tokens=20,
            total_tokens=30,
            provider="lm-studio",
            model="gemma",
            engine_native={"timings": {"predicted_per_second": 12.5}},
        )
        dumped = stats.model_dump()
        assert set(dumped) == {
            "stop_reason",
            "stop_reason_raw",
            "total_ms",
            "ttft_ms",
            "tokens_per_second",
            "prompt_tokens",
            "predicted_tokens",
            "total_tokens",
            "provider",
            "model",
            "engine_native",
        }
        assert dumped["stop_reason"] == "stop"
        assert dumped["predicted_tokens"] == 20
        assert dumped["engine_native"] == {"timings": {"predicted_per_second": 12.5}}

    def test_defaults_are_null_safe(self):
        from text.models.stats import GenerationStats

        stats = GenerationStats(provider="lm-studio", model="m")
        assert stats.prompt_tokens == 0
        assert stats.predicted_tokens == 0
        assert stats.total_tokens == 0
        assert stats.ttft_ms is None
        assert stats.tokens_per_second is None
        assert stats.engine_native is None


# ---------------------------------------------------------------------------
# OpenAI-wire (LM Studio / vLLM / Azure) mapping
# ---------------------------------------------------------------------------


class TestOpenAiCompatMapping:
    def test_openai_compat_maps_usage_and_finish_reason(self):
        from text.models.stats import stats_from_openai_usage

        stats = stats_from_openai_usage(
            provider="lm-studio",
            model="gemma",
            usage={"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
            finish_reason="length",
            total_ms=1000,
        )
        assert stats.stop_reason == "length"
        assert stats.stop_reason_raw == "length"
        assert stats.prompt_tokens == 10
        assert stats.predicted_tokens == 20
        assert stats.total_tokens == 30
        assert stats.provider == "lm-studio"
        assert stats.model == "gemma"
        # client-computed fallback tok/s: 20 predicted / 1.0s
        assert stats.tokens_per_second == pytest.approx(20.0)
        assert stats.engine_native is None

    @pytest.mark.asyncio
    async def test_openai_compat_stream_emits_final_usage_chunk(self):
        """The provider DRAINS past the finish chunk and emits ONE trailing
        ``usage`` StreamChunk carrying the full AD-1 stats, then ``done``.

        Fixture uses the REAL OpenAI-wire ordering (content+finish FIRST, the
        ``stream_options`` usage-only chunk LAST) — the ordering the frozen
        early-return dropped. The usage chunk carries the real normalized stop
        reason (``length``) and ``predicted_tokens``."""
        from text.providers.openai_compat import OpenAICompatProvider

        content_chunk = MagicMock()
        content_chunk.choices = [MagicMock()]
        content_chunk.choices[0].delta.content = "Hi"
        content_chunk.choices[0].delta.reasoning_content = None
        content_chunk.choices[0].delta.reasoning = None
        content_chunk.choices[0].finish_reason = "length"

        usage_chunk = MagicMock()
        usage_chunk.choices = []
        usage_chunk.usage = MagicMock(prompt_tokens=10, completion_tokens=5, total_tokens=15)

        async def _stream(_chunks):
            for c in _chunks:
                yield c

        provider = OpenAICompatProvider()
        provider._client = stub_client(provider, MagicMock())
        provider._client.chat.completions.create = AsyncMock(
            return_value=_stream([content_chunk, usage_chunk])
        )

        chunks: list[StreamChunk] = []
        async for sc in provider.generate_stream(
            GenerateRequest(prompt="hi", stream=True, model="m")
        ):
            chunks.append(sc)

        types = [c.type for c in chunks]
        assert types.count("usage") == 1
        assert types.count("done") == 1
        # drained past the finish: usage precedes done, done is last.
        assert types.index("usage") < types.index("done")
        assert types[-1] == "done"

        data = [c for c in chunks if c.type == "usage"][0].data
        assert data["total_tokens"] == 15
        assert data["prompt_tokens"] == 10
        assert data["predicted_tokens"] == 5
        # real normalized stop reason surfaced on the streamed stats
        assert data["stop_reason"] == "length"


# ---------------------------------------------------------------------------
# Bedrock mapping
# ---------------------------------------------------------------------------


class TestBedrockMapping:
    def test_bedrock_maps_stop_reason_and_usage(self):
        from text.models.stats import stats_from_bedrock

        length_stats = stats_from_bedrock(
            provider="bedrock",
            model="claude",
            usage={"inputTokens": 5, "outputTokens": 10, "totalTokens": 15},
            stop_reason="max_tokens",
            total_ms=1000,
        )
        assert length_stats.stop_reason == "length"
        assert length_stats.prompt_tokens == 5
        assert length_stats.predicted_tokens == 10
        assert length_stats.total_tokens == 15

        guardrail_stats = stats_from_bedrock(
            provider="bedrock",
            model="claude",
            usage={"inputTokens": 5, "outputTokens": 1, "totalTokens": 6},
            stop_reason="guardrail_intervened",
            total_ms=500,
        )
        assert guardrail_stats.stop_reason == "content_filter"


# ---------------------------------------------------------------------------
# Azure content-filter
# ---------------------------------------------------------------------------


class TestAzureMapping:
    def test_azure_content_filter_maps_to_content_filter(self):
        from text.models.stats import normalize_stop_reason, stats_from_openai_usage

        assert normalize_stop_reason("azure-openai", "content_filter") == "content_filter"

        stats = stats_from_openai_usage(
            provider="azure-openai",
            model="gpt-4o",
            usage={"prompt_tokens": 3, "completion_tokens": 0, "total_tokens": 3},
            finish_reason="content_filter",
            total_ms=300,
        )
        assert stats.stop_reason == "content_filter"


# ---------------------------------------------------------------------------
# Client-side fallback / null-safety
# ---------------------------------------------------------------------------


class TestClientSideFallback:
    def test_client_side_fallback_when_engine_omits_usage(self):
        from text.models.stats import stats_from_openai_usage

        stats = stats_from_openai_usage(
            provider="lm-studio",
            model="m",
            usage=None,
            finish_reason=None,
            total_ms=1500,
        )
        # null-safe zeros, no engine-native blob, no invented counts
        assert stats.prompt_tokens == 0
        assert stats.predicted_tokens == 0
        assert stats.total_tokens == 0
        assert stats.engine_native is None
        # without predicted tokens there is nothing to divide → no tok/s invented
        assert stats.tokens_per_second is None
        assert stats.stop_reason in {
            "stop",
            "length",
            "content_filter",
            "tool_call",
            "abort",
            "error",
            "other",
        }

    def test_tok_per_second_computed_from_client_timing_when_engine_omits_it(self):
        from text.models.stats import stats_from_openai_usage

        stats = stats_from_openai_usage(
            provider="lm-studio",
            model="m",
            usage={"prompt_tokens": 0, "completion_tokens": 30, "total_tokens": 30},
            finish_reason="stop",
            total_ms=1000,
        )
        assert stats.tokens_per_second == pytest.approx(30.0)


# ---------------------------------------------------------------------------
# Normalized stop-reason table covers all providers
# ---------------------------------------------------------------------------


class TestNormalizeStopReason:
    @pytest.mark.parametrize(
        "provider,raw,expected",
        [
            ("openai_compat", "stop", "stop"),
            ("lm-studio", "length", "length"),
            ("openai_compat", "content_filter", "content_filter"),
            ("openai_compat", "tool_calls", "tool_call"),
            ("openai_compat", "function_call", "tool_call"),
            ("vllm", "length", "length"),
            ("azure-openai", "content_filter", "content_filter"),
            ("bedrock", "end_turn", "stop"),
            ("bedrock", "stop_sequence", "stop"),
            ("bedrock", "max_tokens", "length"),
            ("bedrock", "guardrail_intervened", "content_filter"),
            ("bedrock", "tool_use", "tool_call"),
            ("llama-cpp", "stopped_eos", "stop"),
            ("llama-cpp", "stopped_word", "stop"),
            ("llama-cpp", "stopped_limit", "length"),
            ("openai_compat", "totally-unknown", "other"),
            ("lm-studio", "", "other"),
        ],
    )
    def test_normalized_stop_reason_enum_covers_all_providers(self, provider, raw, expected):
        from text.models.stats import normalize_stop_reason

        assert normalize_stop_reason(provider, raw) == expected

    def test_case_insensitive(self):
        from text.models.stats import normalize_stop_reason

        assert normalize_stop_reason("bedrock", "MAX_TOKENS") == "length"


# ---------------------------------------------------------------------------
# Observability helper
# ---------------------------------------------------------------------------


class TestObservabilityGenAiSpan:
    def test_set_generation_span_attributes(self):
        from text.core.observability import set_generation_span_attributes

        span = MagicMock()
        span.is_recording.return_value = True
        set_generation_span_attributes(
            span,
            provider="lm-studio",
            model="gemma",
            input_tokens=10,
            output_tokens=20,
            finish_reasons=["length"],
        )
        span.set_attribute.assert_any_call("gen_ai.system", "lm-studio")
        span.set_attribute.assert_any_call("gen_ai.request.model", "gemma")
        span.set_attribute.assert_any_call("gen_ai.usage.input_tokens", 10)
        span.set_attribute.assert_any_call("gen_ai.usage.output_tokens", 20)
        span.set_attribute.assert_any_call("gen_ai.response.finish_reasons", ["length"])


# ---------------------------------------------------------------------------
# Endpoint threading + never-fail-generation resilience
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_provider():
    provider = AsyncMock()
    provider.generate = AsyncMock(
        return_value=(
            "Generated summary",
            "",
            {"prompt_tokens": 50, "completion_tokens": 100, "total_tokens": 150},
        )
    )
    return provider


@pytest.fixture
def mock_registry(mock_provider):
    registry = MagicMock()
    registry.get.return_value = mock_provider
    return registry


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    task_state = MagicMock()
    task_state.task_id = "test-"
    tm.create_task = AsyncMock(return_value=task_state)
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    return tm


@pytest.fixture
def app(mock_registry, mock_task_manager):
    from text.main import create_app

    application = create_app()
    application.state.provider_registry = mock_registry
    application.state.task_manager = mock_task_manager
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestGenerateEndpointStats:
    @pytest.mark.asyncio
    async def test_generate_response_includes_stats(self, client):
        resp = await client.post(
            "/api/v1/generate", json={"prompt": "hello", "provider": "lm-studio", "model": "m"}
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["stats"] is not None
        stats = data["stats"]
        assert stats["prompt_tokens"] == 50
        assert stats["predicted_tokens"] == 100
        assert stats["total_tokens"] == 150
        assert stats["provider"] == "lm-studio"
        assert stats["model"] == "m"
        assert stats["stop_reason"] in {
            "stop",
            "length",
            "content_filter",
            "tool_call",
            "abort",
            "error",
            "other",
        }
        # wire-compat fields preserved
        assert data["usage"]["completion_tokens"] == 100
        assert data["finish_reason"] == "stop"

    @pytest.mark.asyncio
    async def test_nonstream_threads_provider_real_stop_reason(self, client, mock_provider):
        """The endpoint threads the provider's REAL normalized stop reason onto
        the response — it must NOT hard-code ``"stop"`` when the engine reported
        a truncation (``length``). Provider now returns a populated
        ``GenerationStats`` as the third tuple element."""
        from text.models.stats import GenerationStats

        mock_provider.generate = AsyncMock(
            return_value=(
                "Truncated summary",
                "",
                GenerationStats(
                    stop_reason="length",
                    stop_reason_raw="length",
                    total_ms=900,
                    prompt_tokens=50,
                    predicted_tokens=100,
                    total_tokens=150,
                    provider="lm-studio",
                    model="m",
                ),
            )
        )
        resp = await client.post(
            "/api/v1/generate", json={"prompt": "hello", "provider": "lm-studio", "model": "m"}
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["stats"]["stop_reason"] == "length"
        assert data["stats"]["predicted_tokens"] == 100
        # wire-compat finish_reason reflects the real native reason, not "stop"
        assert data["finish_reason"] == "length"
        assert data["usage"]["completion_tokens"] == 100

    @pytest.mark.asyncio
    async def test_stats_never_fail_generation(self, client):
        """A stats-mapper failure must degrade to a best-effort stats object,
        log a warning, and still return a 200 with the generated content."""
        # Wave 0.4: `_coerce_stats` — and with it the
        # `build_generation_stats` call this patches — moved to
        # `text.routing.usage`. Patching by module path names a LOCATION, so a
        # relocation is exactly what invalidates it. Behaviour under test is
        # unchanged: a mapper that raises must still degrade to best-effort
        # stats and return 200.
        with patch(
            "text.routing.usage.build_generation_stats",
            side_effect=RuntimeError("mapper boom"),
        ):
            resp = await client.post(
                "/api/v1/generate",
                json={"prompt": "hello", "provider": "lm-studio", "model": "m"},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["content"] == "Generated summary"
        assert data["stats"] is not None
        assert data["stats"]["stop_reason"] == "error"

    @pytest.mark.asyncio
    async def test_stats_telemetry_failure_never_fails_generation(self, client):
        """A metric/span stamping failure on the success path must NOT bubble
        into the outer except (which would record a false circuit-breaker
        failure, flip the task to FAILED and 5xx a billed generation). It must
        be swallowed: 200 + completed + stats still on the response."""
        with patch(
            "text.api.endpoints.generate.STOP_REASON_TOTAL.labels",
            side_effect=RuntimeError("prometheus boom"),
        ):
            resp = await client.post(
                "/api/v1/generate",
                json={"prompt": "hello", "provider": "lm-studio", "model": "m"},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "completed"
        assert data["content"] == "Generated summary"
        assert data["stats"] is not None
