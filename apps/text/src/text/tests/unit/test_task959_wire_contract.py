"""TASK-959 §10.2 — the compute/network numbers reach BOTH response shapes.

`usage_detail` is the gateway's only view of what a generation cost, and it is
produced in three places: the blocking `/generate` response, the streaming
terminal frame, and the internal judge route. The numbers are useless if only
one of them carries them, so each is asserted here.

The streaming terminal frame additionally gains `data.guardrail_usage`. The
blocking response has always carried the safety plane's own spend in its own
slot; a streamed generation ran the SAME input gate and burned the same
guardrail tokens, and until this ticket that spend had no way off the box. It
is the verdict's usage, passed through — not a second guardrail call.

Byte counting is exercised by having the provider double touch the record the
caller bound, which is exactly what the pooled transport does one layer down
(`test_task959_provider_bytes.py` covers the transport itself). That is the
seam these tests are about: the caller binds a record, and whatever the adapter
put on the wire ends up on `usage_detail`.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from text.models.stats import build_generation_stats
from text.models.stream import StreamChunk
from text.providers.pool import current_byte_counts

_LLAMA_TIMINGS = {"prompt_ms": 200.0, "predicted_ms": 800.0}


def _make_app(registry, task_manager, guardrail_client=None):  # type: ignore[no-untyped-def]
    from text.core.config import InternalAccessConfig
    from text.main import create_app

    app = create_app()
    app.state.settings = app.state.settings.model_copy(
        update={"internal_access": InternalAccessConfig(token=SecretStr(""))}
    )
    app.state.provider_registry = registry
    app.state.task_manager = task_manager
    if guardrail_client is not None:
        app.state.guardrail_client = guardrail_client
    return app


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    state = MagicMock()
    state.task_id = "task-959"
    tm.create_task = AsyncMock(return_value=state)
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    tm.append_batch = AsyncMock()
    tm.is_cancel_requested = AsyncMock(return_value=False)
    return tm


def _appended_chunks(task_manager: Any) -> list[StreamChunk]:
    return [call.args[1] for call in task_manager.append_chunk.await_args_list]


def _llama_stats(total_ms: int = 1500):  # type: ignore[no-untyped-def]
    return build_generation_stats(
        provider="llama-cpp",
        model="qwen",
        raw_stop_reason="stopped_eos",
        prompt_tokens=30,
        predicted_tokens=70,
        total_tokens=100,
        total_ms=total_ms,
        engine_native={"timings": _LLAMA_TIMINGS},
    )


@pytest_asyncio.fixture
async def blocking_client(mock_task_manager):
    """A `/generate` client whose provider ALSO puts bytes on the record.

    The byte touch stands in for the pooled transport: what matters at this
    layer is that the caller bound a record around the provider call and read it
    back afterwards.
    """

    async def _generate(_request):  # type: ignore[no-untyped-def]
        record = current_byte_counts()
        assert record is not None, "the caller must bind a byte record around the provider call"
        record.add_request(640)
        record.add_response(2048)
        return "note", "", _llama_stats()

    provider = AsyncMock()
    provider.generate = _generate
    registry = MagicMock()
    registry.get.return_value = provider

    app = _make_app(registry, mock_task_manager)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client


class TestBlockingResponse:
    @pytest.mark.asyncio
    async def test_total_ms_and_engine_ms_reach_usage_detail(self, blocking_client) -> None:
        resp = await blocking_client.post(
            "/api/v1/generate",
            json={"prompt": "p", "provider": "llama-cpp", "model": "qwen"},
            headers={"X-Tenant-Id": "t-1"},
        )
        assert resp.status_code == 200
        detail = resp.json()["usage_detail"]
        assert detail["total_ms"] == 1500
        # 200 ms prefill + 800 ms decode — the ENGINE's time, not the wall clock.
        assert detail["engine_ms"] == 1000

    @pytest.mark.asyncio
    async def test_body_bytes_reach_usage_detail(self, blocking_client) -> None:
        resp = await blocking_client.post(
            "/api/v1/generate",
            json={"prompt": "p", "provider": "llama-cpp", "model": "qwen"},
            headers={"X-Tenant-Id": "t-1"},
        )
        detail = resp.json()["usage_detail"]
        assert detail["request_bytes"] == 640
        assert detail["response_bytes"] == 2048

    @pytest.mark.asyncio
    async def test_an_adapter_off_the_pool_reports_no_bytes_rather_than_zero(
        self, mock_task_manager
    ) -> None:
        """Nothing observed the wire ⇒ the fields are ABSENT.

        Zero would claim the call sent nothing, which is a different (and false)
        statement about a Bedrock stream or a mocked provider.
        """
        provider = AsyncMock()
        provider.generate = AsyncMock(return_value=("note", "", _llama_stats()))
        registry = MagicMock()
        registry.get.return_value = provider
        app = _make_app(registry, mock_task_manager)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/api/v1/generate",
                json={"prompt": "p", "provider": "llama-cpp", "model": "qwen"},
                headers={"X-Tenant-Id": "t-1"},
            )
        detail = resp.json()["usage_detail"]
        assert "request_bytes" not in detail
        assert "response_bytes" not in detail
        assert detail["total_ms"] == 1500

    @pytest.mark.asyncio
    async def test_the_persisted_task_carries_the_same_block(
        self, blocking_client, mock_task_manager
    ) -> None:
        """`GET /tasks/{id}` must not disagree with the response it mirrors."""
        await blocking_client.post(
            "/api/v1/generate",
            json={"prompt": "p", "provider": "llama-cpp", "model": "qwen"},
            headers={"X-Tenant-Id": "t-1"},
        )
        persisted = [
            call.kwargs["usage_detail"]
            for call in mock_task_manager.update_task.await_args_list
            if call.kwargs.get("usage_detail")
        ]
        assert persisted, "the completed task must persist its usage_detail"
        assert persisted[-1]["total_ms"] == 1500
        assert persisted[-1]["request_bytes"] == 640


class TestStreamingTerminalFrame:
    @pytest.mark.asyncio
    async def test_terminal_frame_carries_total_ms(self, mock_task_manager) -> None:
        from text.api.endpoints.generate import _run_streaming_generation
        from text.models.requests import GenerateRequest

        async def _stream(_request):  # type: ignore[no-untyped-def]
            yield StreamChunk(type="chunk", content="hi")
            yield StreamChunk(
                type="usage",
                data={
                    "prompt_tokens": 4,
                    "predicted_tokens": 9,
                    "total_tokens": 13,
                    "engine_native": {"timings": _LLAMA_TIMINGS},
                },
            )
            yield StreamChunk(type="done", data={"finish_reason": "stop"})

        provider = AsyncMock()
        provider.generate_stream = _stream

        await _run_streaming_generation(
            mock_task_manager,
            provider,
            "task-stream",
            GenerateRequest(prompt="p", provider="llama-cpp", model="qwen", stream=True),
            provider_name="llama-cpp",
            model="qwen",
            request_id="req-1",
        )

        terminal = _appended_chunks(mock_task_manager)[-1]
        assert terminal.type == "done"
        usage = (terminal.data or {})["usage"]
        assert usage["total_ms"] >= 0
        # The engine time rides on the streamed `usage` chunk's engine_native.
        assert usage["engine_ms"] == 1000

    @pytest.mark.asyncio
    async def test_terminal_frame_carries_bytes_when_the_stream_was_on_the_pool(
        self, mock_task_manager
    ) -> None:
        from text.api.endpoints.generate import _run_streaming_generation
        from text.models.requests import GenerateRequest

        async def _stream(_request):  # type: ignore[no-untyped-def]
            record = current_byte_counts()
            assert record is not None, "the producer must bind a byte record around the stream"
            record.add_request(128)
            yield StreamChunk(type="chunk", content="hi")
            record.add_response(64)
            yield StreamChunk(type="usage", data={"prompt_tokens": 1, "predicted_tokens": 1})
            record.add_response(64)
            yield StreamChunk(type="done", data={"finish_reason": "stop"})

        provider = AsyncMock()
        provider.generate_stream = _stream

        await _run_streaming_generation(
            mock_task_manager,
            provider,
            "task-bytes",
            GenerateRequest(prompt="p", provider="openai", model="gpt-5", stream=True),
            provider_name="openai",
            model="gpt-5",
        )

        usage = (_appended_chunks(mock_task_manager)[-1].data or {})["usage"]
        assert usage["request_bytes"] == 128
        assert usage["response_bytes"] == 128

    @pytest.mark.asyncio
    async def test_terminal_frame_carries_guardrail_usage(self, mock_task_manager) -> None:
        """The safety plane's spend on a STREAMED generation now has a way out."""
        from text.api.endpoints.generate import _run_streaming_generation
        from text.models.requests import GenerateRequest
        from text.models.usage import build_usage_detail

        guardrail_usage = build_usage_detail(
            task_id="judge-1",
            request_id="req-1",
            provider="lm-studio",
            model="granite-guardian",
            prompt_tokens=300,
            completion_tokens=4,
            total_ms=40,
        ).model_dump(mode="json")

        async def _stream(_request):  # type: ignore[no-untyped-def]
            yield StreamChunk(type="chunk", content="hi")
            yield StreamChunk(type="done", data={"finish_reason": "stop"})

        provider = AsyncMock()
        provider.generate_stream = _stream

        await _run_streaming_generation(
            mock_task_manager,
            provider,
            "task-guard",
            GenerateRequest(prompt="p", provider="openai", model="gpt-5", stream=True),
            provider_name="openai",
            model="gpt-5",
            guardrail_usage=guardrail_usage,
        )

        data = _appended_chunks(mock_task_manager)[-1].data or {}
        assert data["guardrail_usage"]["provider"] == "lm-studio"
        assert data["guardrail_usage"]["prompt_tokens"] == 300
        assert data["guardrail_usage"]["total_ms"] == 40

    @pytest.mark.asyncio
    async def test_guardrail_usage_is_omitted_when_there_was_none(self, mock_task_manager) -> None:
        """Silence, not an empty object: a zero row is indistinguishable from a
        free call, and moderation may legitimately have been disabled."""
        from text.api.endpoints.generate import _run_streaming_generation
        from text.models.requests import GenerateRequest

        async def _stream(_request):  # type: ignore[no-untyped-def]
            yield StreamChunk(type="done", data={"finish_reason": "stop"})

        provider = AsyncMock()
        provider.generate_stream = _stream

        await _run_streaming_generation(
            mock_task_manager,
            provider,
            "task-noguard",
            GenerateRequest(prompt="p", provider="openai", model="gpt-5", stream=True),
            provider_name="openai",
            model="gpt-5",
        )

        assert "guardrail_usage" not in (_appended_chunks(mock_task_manager)[-1].data or {})

    @pytest.mark.asyncio
    async def test_an_aborted_stream_reports_its_guardrail_spend_too(
        self, mock_task_manager
    ) -> None:
        """The input gate ran before the provider did; a stream that died after
        it still owes those tokens to the ledger."""
        from text.api.endpoints.generate import _run_streaming_generation
        from text.models.requests import GenerateRequest
        from text.models.usage import build_usage_detail

        guardrail_usage = build_usage_detail(
            task_id="judge-2",
            request_id=None,
            provider="lm-studio",
            model="granite-guardian",
            prompt_tokens=12,
            completion_tokens=1,
        ).model_dump(mode="json")

        async def _dying(_request):  # type: ignore[no-untyped-def]
            yield StreamChunk(type="chunk", content="partial")
            raise RuntimeError("upstream hung up")

        provider = AsyncMock()
        provider.generate_stream = _dying

        await _run_streaming_generation(
            mock_task_manager,
            provider,
            "task-abort",
            GenerateRequest(prompt="p", provider="openai", model="gpt-5", stream=True),
            provider_name="openai",
            model="gpt-5",
            guardrail_usage=guardrail_usage,
        )

        terminal = _appended_chunks(mock_task_manager)[-1]
        assert terminal.type == "error"
        assert (terminal.data or {})["guardrail_usage"]["prompt_tokens"] == 12


class TestSseWireShape:
    @pytest.mark.asyncio
    async def test_the_done_frame_a_client_receives_carries_both_blocks(
        self, mock_task_manager
    ) -> None:
        """End to end over the real SSE response, because the terminal frame is
        the gateway's actual metering input."""

        async def _stream(_request):  # type: ignore[no-untyped-def]
            yield StreamChunk(type="chunk", content="hi")
            yield StreamChunk(type="done", data={"finish_reason": "stop"})

        provider = AsyncMock()
        provider.generate_stream = _stream
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
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/api/v1/generate",
                json={"prompt": "p", "provider": "openai", "model": "gpt-5", "stream": True},
                headers={"X-Tenant-Id": "t-sse"},
            )
            body = resp.text

        assert resp.status_code == 200
        frames = [
            json.loads(line[len("data: ") :])
            for line in body.splitlines()
            if line.startswith("data: ")
        ]
        done = [f for f in frames if f.get("type") == "done"]
        assert done, f"no terminal frame in {body!r}"
        data = done[-1]["data"]
        assert "total_ms" in data["usage"]
        assert data["guardrail_usage"]["provider"] == "lm-studio"


class TestJudgeRoute:
    @pytest.mark.asyncio
    async def test_the_judge_usage_detail_carries_compute_and_bytes(
        self, mock_task_manager
    ) -> None:
        """Guardrail forwards this object verbatim, so what it omits is lost."""
        from text.api.endpoints.judge import JudgeRequest, _run_judge

        async def _generate(_request):  # type: ignore[no-untyped-def]
            record = current_byte_counts()
            assert record is not None, "the judge lane must bind a byte record"
            record.add_request(320)
            record.add_response(96)
            return "safe", "", _llama_stats(total_ms=400)

        provider = AsyncMock()
        provider.generate = _generate
        registry = MagicMock()
        registry.get.return_value = provider

        response = await _run_judge(
            JudgeRequest(prompt="p", provider="llama-cpp", model="qwen"),
            registry=registry,
            judge_semaphores={},
            judge_breakers={},
            app_state=None,
            tenant_id="t-judge",
        )

        detail = response.usage_detail
        assert detail is not None
        assert detail.total_ms == 400
        assert detail.engine_ms == 1000
        assert detail.request_bytes == 320
        assert detail.response_bytes == 96
