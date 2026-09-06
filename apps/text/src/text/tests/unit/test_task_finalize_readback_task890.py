"""TASK-890 — ``GET /tasks/{id}`` answers what was generated and what it cost.

``TaskResponse`` has declared ``content`` and ``usage`` since it was written, but the state this
service persisted carried neither, so the route answered ``content: null`` / ``usage: null`` for
every completed generation. That is not cosmetic: the gateway's two benches finalize by reading
the task back SERVER-SIDE (they never trust the browser to hand the text back), so a prompt-bench
run scored an EMPTY STRING and metered NOTHING — the response model promised a contract the state
could not keep.

Both terminal paths — the streaming producer and the blocking endpoint — now record the same two
fields. No new exposure: the deltas are already in the task's own Redis stream under the same TTL,
so this stores the assembled form of bytes that are already there and expires with them.
"""

from __future__ import annotations

import fakeredis.aioredis as fakeasync
import pytest
import pytest_asyncio

from text.models.responses import TaskResponse
from text.models.task import TaskState, TaskStatus
from text.models.usage import build_usage_detail
from text.services.task_manager import TaskManager


@pytest_asyncio.fixture
async def redis_client():
    r = fakeasync.FakeRedis()
    yield r
    await r.flushall()
    await r.aclose()


@pytest_asyncio.fixture
async def task_manager(redis_client):
    return TaskManager(redis=redis_client, task_ttl=3600)


class TestTaskStateCarriesTheReadback:
    def test_the_state_declares_the_two_fields_the_response_promises(self) -> None:
        assert "content" in TaskState.model_fields
        assert "usage" in TaskState.model_fields

    def test_they_default_to_absent_rather_than_to_an_empty_answer(self) -> None:
        state = TaskState(task_id="t", status=TaskStatus.PENDING, provider="p", model="m")

        assert state.content is None
        assert state.usage is None

    @pytest.mark.asyncio
    async def test_a_terminal_update_round_trips_content_and_usage(self, task_manager) -> None:
        task = await task_manager.create_task(provider="lm-studio", model="gemma")

        updated = await task_manager.update_task(
            task.task_id,
            status=TaskStatus.COMPLETED,
            content="the note",
            usage={"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        )

        assert updated is not None
        assert updated.content == "the note"
        assert updated.usage is not None
        assert updated.usage.prompt_tokens == 10
        assert updated.usage.completion_tokens == 20

    @pytest.mark.asyncio
    async def test_the_route_shape_a_finalize_reads_is_populated(self, task_manager) -> None:
        """What `fetchTextTaskOutput` in the gateway actually reads: `content` + `usage.*`."""
        task = await task_manager.create_task(provider="lm-studio", model="gemma")
        await task_manager.update_task(
            task.task_id,
            status=TaskStatus.COMPLETED,
            content="the note",
            usage={"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        )

        state = await task_manager.get_task(task.task_id)
        assert state is not None
        body = TaskResponse.model_validate(state.model_dump(mode="json"))

        assert body.content == "the note"
        assert body.usage is not None
        assert body.usage.completion_tokens == 20


class TestTheReadbackCarriesTheBillingBlock:
    """J3-4 — ``usage`` counts alone are not a meterable block.

    The gateway's ledger refuses to guess: ``parseTextUsageDetail`` returns ``null`` unless the
    block names an ``endpoint_kind`` it knows, because choosing between inclusive and exclusive
    input arithmetic on a hunch is a coin flip that lands on an invoice. ``TokenUsage`` carries
    three integers and no endpoint kind, no ``byok``, no ``cost_basis`` and no ``occurred_at``, so
    the draft-agent bench read ``usage_detail`` off this route, found nothing, and recorded NOTHING
    — silently, for every bench run, while the console displayed the token total.

    The block already exists on both terminal paths (``build_usage_detail``); it was simply never
    persisted with the task. This is the smaller of the two fixes the finding named: one serializer
    here, rather than a gateway that re-derives an endpoint kind it never observed.
    """

    def test_the_state_declares_the_block_the_ledger_meters_from(self) -> None:
        assert "usage_detail" in TaskState.model_fields

    def test_the_response_model_exposes_it(self) -> None:
        assert "usage_detail" in TaskResponse.model_fields

    def test_it_defaults_to_absent_rather_than_to_an_empty_block(self) -> None:
        state = TaskState(task_id="t", status=TaskStatus.PENDING, provider="p", model="m")

        assert state.usage_detail is None

    @pytest.mark.asyncio
    async def test_a_terminal_update_round_trips_the_meterable_block(self, task_manager) -> None:
        task = await task_manager.create_task(provider="lm-studio", model="gemma")
        detail = build_usage_detail(
            task_id=task.task_id,
            request_id="req-1",
            provider="lm-studio",
            model="gemma",
            prompt_tokens=10,
            completion_tokens=20,
        ).model_dump(mode="json")

        await task_manager.update_task(
            task.task_id,
            status=TaskStatus.COMPLETED,
            content="the note",
            usage={"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
            usage_detail=detail,
        )

        state = await task_manager.get_task(task.task_id)
        assert state is not None
        body = TaskResponse.model_validate(state.model_dump(mode="json"))

        assert body.usage_detail is not None
        # The four keys the gateway's `parseTextUsageDetail` refuses to proceed without.
        dumped = body.usage_detail.model_dump(mode="json")
        assert dumped["endpoint_kind"] == "lmstudio.chat"
        assert dumped["cost_basis"] == "INTERNAL"
        assert dumped["prompt_tokens"] == 10
        assert dumped["occurred_at"]


class TestBothTerminalPathsPersistTheBlock:
    """The two ways a generation ends must leave the SAME readback behind.

    A bench does not know (and must not care) whether the author's run streamed or blocked, so a
    block persisted on only one of the paths is a metering gap that reappears the moment the
    console changes mode — which is precisely how the SSE relay came to bill nothing while the
    blocking relay billed correctly.
    """

    @pytest.mark.asyncio
    async def test_the_streaming_terminal_persists_the_same_block_it_framed(self) -> None:
        from unittest.mock import AsyncMock, MagicMock

        from text.api.endpoints.generate import _run_streaming_generation
        from text.models.requests import GenerateRequest
        from text.models.stream import StreamChunk

        task_manager = AsyncMock()
        task_manager.create_task = AsyncMock(return_value=MagicMock(task_id="task-1"))
        task_manager.update_task = AsyncMock()
        task_manager.append_chunk = AsyncMock()

        async def stream(_request):
            yield StreamChunk(type="chunk", content="the note")
            yield StreamChunk(
                type="usage", data={"prompt_tokens": 11, "predicted_tokens": 22, "total_tokens": 33}
            )
            yield StreamChunk(type="done", data={"finish_reason": "stop"})

        provider = AsyncMock()
        provider.generate_stream = stream

        await _run_streaming_generation(
            task_manager,
            provider,
            "task-stream",
            GenerateRequest(prompt="p", provider="lm-studio", model="m", stream=True),
            provider_name="lm-studio",
            model="m",
            tenant_id="t",
            request_id="req-stream",
        )

        terminal = task_manager.update_task.await_args_list[-1].kwargs
        assert terminal["status"] == TaskStatus.COMPLETED
        detail = terminal["usage_detail"]
        assert detail["endpoint_kind"] == "lmstudio.chat"
        assert detail["prompt_tokens"] == 11
        assert detail["completion_tokens"] == 22
        # The persisted block IS the framed block — a bench that finalizes and a gateway that
        # tees the stream must never be able to disagree about one generation.
        framed = [
            chunk.data
            for chunk in (call.args[1] for call in task_manager.append_chunk.await_args_list)
            if chunk.type == "done"
        ]
        assert framed and framed[-1]["usage"] == detail
