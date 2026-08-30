"""Text usage metering: audit truth + gateway passthrough.

Three defects are locked down here:

1. **The streaming audit event was a lie.** ``/generate?stream=true`` logged a
   ``generation.audit`` record with ZERO tokens *before* the generation started,
   and the background task that actually knew the totals never logged at all. An
   audit event must describe what happened, not what is about to.
2. **No ``tenant_id``.** Every audit path recorded provider/model/tokens with no
   way to attribute them to a tenant.
3. **Streaming usage never reached the gateway.** The gateway can only emit
   ledger rows for tokens it is told about, and the SSE stream carried none —
   least of all on the abort path (the dropped-tail bug class).

The abort case is written FIRST on purpose: a stream that dies after burning
tokens is the case that silently loses money.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.models.stream import StreamChunk


class _AuditSpy:
    """Captures ``GenerationAuditEvent``s instead of logging them."""

    def __init__(self) -> None:
        self.events: list[Any] = []

    def log_generation(self, event: Any) -> None:
        self.events.append(event)


def _appended_chunks(task_manager: Any) -> list[StreamChunk]:
    return [call.args[1] for call in task_manager.append_chunk.await_args_list]


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    task_state = MagicMock()
    task_state.task_id = "task-1"
    tm.create_task = AsyncMock(return_value=task_state)
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    return tm


# ---------------------------------------------------------------------------
# 1. Streaming teardown — abort FIRST, then completion
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_abort_emits_cumulative_usage_and_real_audit(mock_task_manager):
    """A stream that dies mid-flight still reports the tokens already burned.

    The provider yielded usage and then raised. The tokens were spent, so the
    audit event must carry them (not zeros) and the terminal ``error`` frame must
    carry the same numbers marked ``interrupted`` — that block is the only thing
    the gateway can emit a ledger row from.
    """
    from text.api.endpoints.generate import _run_streaming_generation
    from text.models.requests import GenerateRequest

    async def dying_stream(_request):
        yield StreamChunk(type="chunk", content="partial")
        yield StreamChunk(
            type="usage",
            data={"prompt_tokens": 120, "predicted_tokens": 34, "total_tokens": 154},
        )
        raise RuntimeError("upstream hung up")

    provider = AsyncMock()
    provider.generate_stream = dying_stream
    audit = _AuditSpy()

    await _run_streaming_generation(
        mock_task_manager,
        provider,
        "task-abort",
        GenerateRequest(prompt="p", provider="ollama", model="m", stream=True),
        provider_name="ollama",
        model="m",
        generation_audit=audit,
        tenant_id="tenant-abort",
        request_id="req-abort",
    )

    assert len(audit.events) == 1
    event = audit.events[0]
    assert event.tenant_id == "tenant-abort"
    assert event.prompt_tokens == 120
    assert event.completion_tokens == 34
    assert event.total_tokens == 154

    terminal = _appended_chunks(mock_task_manager)[-1]
    assert terminal.type == "error"
    usage = (terminal.data or {}).get("usage")
    assert usage is not None, "the abort frame must carry the usage seen so far"
    assert usage["prompt_tokens"] == 120
    assert usage["completion_tokens"] == 34
    assert usage["interrupted"] is True
    assert usage["task_id"] == "task-abort"


@pytest.mark.asyncio
async def test_stream_completion_logs_real_totals_with_tenant_id(mock_task_manager):
    from text.api.endpoints.generate import _run_streaming_generation
    from text.models.requests import GenerateRequest

    async def stream(_request):
        yield StreamChunk(type="chunk", content="hello")
        yield StreamChunk(
            type="usage",
            data={"prompt_tokens": 11, "predicted_tokens": 7, "total_tokens": 18},
        )
        yield StreamChunk(type="done", data={"finish_reason": "stop"})

    provider = AsyncMock()
    provider.generate_stream = stream
    audit = _AuditSpy()

    await _run_streaming_generation(
        mock_task_manager,
        provider,
        "task-ok",
        GenerateRequest(prompt="p", provider="anthropic", model="claude", stream=True),
        provider_name="anthropic",
        model="claude",
        generation_audit=audit,
        tenant_id="tenant-ok",
        request_id="req-ok",
    )

    assert len(audit.events) == 1
    event = audit.events[0]
    assert event.status == "completed"
    assert event.tenant_id == "tenant-ok"
    assert (event.prompt_tokens, event.completion_tokens, event.total_tokens) == (11, 7, 18)
    assert event.latency_ms >= 0


@pytest.mark.asyncio
async def test_terminal_done_frame_carries_usage_block(mock_task_manager):
    """The gateway emits from the LAST frame — so the last frame must be ``done``."""
    from text.api.endpoints.generate import _run_streaming_generation
    from text.models.requests import GenerateRequest

    async def stream(_request):
        yield StreamChunk(type="chunk", content="hi")
        yield StreamChunk(
            type="usage",
            data={"prompt_tokens": 5, "predicted_tokens": 2, "total_tokens": 7},
        )
        yield StreamChunk(type="done", data={"finish_reason": "stop"})

    provider = AsyncMock()
    provider.generate_stream = stream

    await _run_streaming_generation(
        mock_task_manager,
        provider,
        "task-done",
        GenerateRequest(prompt="p", provider="lm-studio", model="qwen", stream=True),
        provider_name="lm-studio",
        model="qwen",
        tenant_id="tenant-done",
        request_id="req-done",
    )

    chunks = _appended_chunks(mock_task_manager)
    assert chunks[-1].type == "done", "a frame after `done` would never be delivered"
    data = chunks[-1].data or {}
    assert data["finish_reason"] == "stop"
    usage = data["usage"]
    assert usage["task_id"] == "task-done"
    assert usage["request_id"] == "req-done"
    assert usage["provider"] == "lm-studio"
    assert usage["model"] == "qwen"
    assert usage["endpoint_kind"] == "lmstudio.chat"
    assert usage["interrupted"] is False
    assert usage["prompt_tokens"] == 5
    assert usage["completion_tokens"] == 2
    assert usage["occurred_at"].endswith("+00:00") or usage["occurred_at"].endswith("Z")


@pytest.mark.asyncio
async def test_usage_chunks_are_take_last_never_summed(mock_task_manager):
    """Anthropic restates usage cumulatively — summing multiplies the bill."""
    from text.api.endpoints.generate import _run_streaming_generation
    from text.models.requests import GenerateRequest

    async def stream(_request):
        yield StreamChunk(
            type="usage", data={"prompt_tokens": 100, "predicted_tokens": 10, "total_tokens": 110}
        )
        yield StreamChunk(
            type="usage", data={"prompt_tokens": 100, "predicted_tokens": 25, "total_tokens": 125}
        )
        yield StreamChunk(type="done", data={"finish_reason": "stop"})

    provider = AsyncMock()
    provider.generate_stream = stream
    audit = _AuditSpy()

    await _run_streaming_generation(
        mock_task_manager,
        provider,
        "task-cumulative",
        GenerateRequest(prompt="p", provider="anthropic", model="claude", stream=True),
        provider_name="anthropic",
        model="claude",
        generation_audit=audit,
        tenant_id="t",
        request_id="r",
    )

    event = audit.events[0]
    assert (event.prompt_tokens, event.completion_tokens) == (100, 25)


@pytest.mark.asyncio
async def test_stream_carries_raw_usage_for_the_normalizer(mock_task_manager):
    """``engine_native.usage`` is the provider-wire blob the WS-B normalizer parses."""
    from text.api.endpoints.generate import _run_streaming_generation
    from text.models.requests import GenerateRequest

    raw = {
        "prompt_tokens": 900,
        "completion_tokens": 40,
        "prompt_tokens_details": {"cached_tokens": 800},
        "completion_tokens_details": {"reasoning_tokens": 15},
    }

    async def stream(_request):
        yield StreamChunk(
            type="usage",
            data={
                "prompt_tokens": 900,
                "predicted_tokens": 40,
                "total_tokens": 940,
                "engine_native": {"usage": raw},
            },
        )
        yield StreamChunk(type="done", data={"finish_reason": "stop"})

    provider = AsyncMock()
    provider.generate_stream = stream

    await _run_streaming_generation(
        mock_task_manager,
        provider,
        "task-raw",
        GenerateRequest(prompt="p", provider="openai", model="gpt", stream=True),
        provider_name="openai",
        model="gpt",
        tenant_id="t",
        request_id="r",
    )

    usage = (_appended_chunks(mock_task_manager)[-1].data or {})["usage"]
    assert usage["raw"] == raw
    assert usage["endpoint_kind"] == "openai.chat"


# ---------------------------------------------------------------------------
# 2. Endpoint-kind vocabulary
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("provider", "expected"),
    [
        ("openai", "openai.chat"),
        ("azure-openai", "openai.chat"),
        ("azure", "openai.chat"),
        ("vllm", "openai.chat"),
        ("openai_compat", "openai.chat"),
        ("lm-studio", "lmstudio.chat"),
        ("anthropic", "anthropic.messages"),
        ("bedrock", "bedrock.converse"),
        ("vertex", "vertex.generate"),
        ("llama-cpp", "llamacpp.native"),
        # Unknown providers speak the portability wire — same default as
        # `normalize_stop_reason`.
        ("some-new-compat-server", "openai.chat"),
    ],
)
def test_endpoint_kind_for_provider(provider: str, expected: str) -> None:
    from text.models.usage import endpoint_kind_for

    assert endpoint_kind_for(provider) == expected


# ---------------------------------------------------------------------------
# 3. Raw-usage preservation — the cache/reasoning breakdown the gateway prices
# ---------------------------------------------------------------------------


class _Details:
    def __init__(self, **fields: Any) -> None:
        self.__dict__.update(fields)


class _OpenAiUsage:
    """Stands in for the OpenAI SDK's usage object (attribute access, not dict)."""

    def __init__(self, **fields: Any) -> None:
        self.__dict__.update(fields)


def test_openai_usage_dict_preserves_cache_and_reasoning_detail() -> None:
    """The flat three-field dict cannot express a cache hit — and cache-read
    tokens cost ~10% of an input token, so collapsing them over-bills by ~10x on
    a cache-heavy prompt."""
    from text.models.usage import openai_usage_dict

    usage = openai_usage_dict(
        _OpenAiUsage(
            prompt_tokens=1000,
            completion_tokens=50,
            total_tokens=1050,
            prompt_tokens_details=_Details(cached_tokens=900, cache_write_tokens=0),
            completion_tokens_details=_Details(reasoning_tokens=20),
        )
    )

    assert usage["prompt_tokens"] == 1000
    assert usage["completion_tokens"] == 50
    assert usage["prompt_tokens_details"]["cached_tokens"] == 900
    assert usage["completion_tokens_details"]["reasoning_tokens"] == 20


def test_openai_usage_dict_omits_absent_detail_blocks() -> None:
    """A provider that reports no breakdown must not gain invented zero keys —
    "no cache reported" and "cache reported as zero" are different facts."""
    from text.models.usage import openai_usage_dict

    usage = openai_usage_dict(_OpenAiUsage(prompt_tokens=10, completion_tokens=2, total_tokens=12))

    assert usage == {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}


def test_openai_usage_dict_is_null_safe() -> None:
    from text.models.usage import openai_usage_dict

    assert openai_usage_dict(None) == {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
    }


def test_vertex_usage_dict_uses_the_wire_field_names() -> None:
    """The Vertex SDK exposes snake_case attributes; the normalizer branches on
    the JSON wire names. Emitting the SDK spelling would silently zero every
    Vertex token count."""
    from text.models.usage import vertex_usage_dict

    usage = vertex_usage_dict(
        _Details(
            prompt_token_count=500,
            candidates_token_count=80,
            total_token_count=620,
            thoughts_token_count=40,
            cached_content_token_count=100,
        )
    )

    assert usage == {
        "promptTokenCount": 500,
        "candidatesTokenCount": 80,
        "totalTokenCount": 620,
        "thoughtsTokenCount": 40,
        "cachedContentTokenCount": 100,
    }


def test_anthropic_usage_dict_keeps_cache_counts_and_ttl_split() -> None:
    """Anthropic's ``input_tokens`` EXCLUDES cache — the cache fields are not a
    detail, they are part of the input total."""
    from text.models.usage import anthropic_usage_dict

    usage = anthropic_usage_dict(
        _Details(
            input_tokens=200,
            output_tokens=90,
            cache_read_input_tokens=1800,
            cache_creation_input_tokens=400,
            cache_creation=_Details(ephemeral_5m_input_tokens=400, ephemeral_1h_input_tokens=0),
            service_tier="standard",
        )
    )

    assert usage["input_tokens"] == 200
    assert usage["output_tokens"] == 90
    assert usage["cache_read_input_tokens"] == 1800
    assert usage["cache_creation_input_tokens"] == 400
    assert usage["cache_creation"]["ephemeral_5m_input_tokens"] == 400
    assert usage["service_tier"] == "standard"


# ---------------------------------------------------------------------------
# 4. Non-streaming passthrough + guardrail forwarding
# ---------------------------------------------------------------------------


def _make_app(registry, task_manager, guardrail_client=None):
    from pydantic import SecretStr

    from text.core.config import InternalAccessConfig
    from text.main import create_app

    app = create_app()
    # Empty token = the documented dev-mode auth bypass. Pinned here rather than
    # inherited from the ambient env file so these tests behave the same run
    # standalone as they do inside the full suite. The token lives on the nested
    # `internal_access` config now — the legacy per-service one is retired.
    app.state.settings = app.state.settings.model_copy(
        update={"internal_access": InternalAccessConfig(token=SecretStr(""))}
    )
    app.state.provider_registry = registry
    app.state.task_manager = task_manager
    if guardrail_client is not None:
        app.state.guardrail_client = guardrail_client
    return app


@pytest_asyncio.fixture
async def sync_client(mock_task_manager):
    from text.models.stats import build_generation_stats

    stats = build_generation_stats(
        provider="openai",
        model="gpt-5",
        raw_stop_reason="stop",
        prompt_tokens=900,
        predicted_tokens=40,
        total_tokens=940,
        total_ms=12,
        engine_native={
            "usage": {
                "prompt_tokens": 900,
                "completion_tokens": 40,
                "prompt_tokens_details": {"cached_tokens": 800},
                "completion_tokens_details": {"reasoning_tokens": 15},
            }
        },
    )
    provider = AsyncMock()
    provider.generate = AsyncMock(return_value=("summary", "", stats))
    registry = MagicMock()
    registry.get.return_value = provider

    guardrail = AsyncMock()
    guardrail.validate = AsyncMock(
        return_value={
            "allowed": True,
            "raw": {
                "stats": {
                    "provider": "lm-studio",
                    "model": "granite-guardian",
                    "prompt_tokens": 300,
                    "predicted_tokens": 4,
                    "total_tokens": 304,
                    "total_ms": 40,
                }
            },
        }
    )

    app = _make_app(registry, mock_task_manager, guardrail)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


@pytest.mark.asyncio
async def test_sync_generate_returns_usage_detail(sync_client):
    resp = await sync_client.post(
        "/api/v1/generate",
        json={"prompt": "hello", "provider": "openai", "model": "gpt-5"},
        headers={"X-Tenant-Id": "tenant-sync"},
    )

    assert resp.status_code == 200
    detail = resp.json()["usage_detail"]
    assert detail["provider"] == "openai"
    assert detail["model"] == "gpt-5"
    assert detail["endpoint_kind"] == "openai.chat"
    assert detail["prompt_tokens"] == 900
    assert detail["completion_tokens"] == 40
    assert detail["interrupted"] is False
    # The cache/reasoning detail the gateway normalizer needs.
    assert detail["raw"]["prompt_tokens_details"]["cached_tokens"] == 800
    assert detail["raw"]["completion_tokens_details"]["reasoning_tokens"] == 15


@pytest.mark.asyncio
async def test_sync_generate_forwards_guardrail_usage(sync_client):
    resp = await sync_client.post(
        "/api/v1/generate",
        json={"prompt": "hello", "provider": "openai", "model": "gpt-5"},
        headers={"X-Tenant-Id": "tenant-sync"},
    )

    assert resp.status_code == 200
    guardrail_usage = resp.json()["guardrail_usage"]
    assert guardrail_usage is not None, "guardrail's own token spend must reach the gateway"
    assert guardrail_usage["provider"] == "lm-studio"
    assert guardrail_usage["model"] == "granite-guardian"
    assert guardrail_usage["prompt_tokens"] == 300
    assert guardrail_usage["completion_tokens"] == 4
    assert guardrail_usage["endpoint_kind"] == "lmstudio.chat"


@pytest.mark.asyncio
async def test_streaming_start_does_not_log_a_zero_token_placeholder(
    mock_task_manager, monkeypatch
):
    """The pre-generation ``status="streaming"`` audit record is gone.

    It described a generation that had not happened yet, with zero tokens — the
    exact shape a metering reader would mistake for a free call.
    """
    from text.core import dependencies
    from text.models.stats import build_generation_stats

    audit = _AuditSpy()

    async def stream(_request):
        yield StreamChunk(type="chunk", content="x")
        yield StreamChunk(type="done", data={"finish_reason": "stop"})

    provider = AsyncMock()
    provider.generate_stream = stream
    provider.generate = AsyncMock(
        return_value=(
            "x",
            "",
            build_generation_stats(
                provider="ollama",
                model="m",
                raw_stop_reason="stop",
                prompt_tokens=1,
                predicted_tokens=1,
                total_ms=1,
            ),
        )
    )
    registry = MagicMock()
    registry.get.return_value = provider

    app = _make_app(registry, mock_task_manager)
    app.dependency_overrides[dependencies.get_generation_audit_logger] = lambda: audit

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "hi", "provider": "ollama", "model": "m", "stream": True},
            headers={"X-Tenant-Id": "tenant-stream"},
        )

    # TASK-818: the stream is the response now (200 + SSE), not a 202 envelope.
    assert resp.status_code == 200
    assert [e for e in audit.events if e.status == "streaming"] == []
