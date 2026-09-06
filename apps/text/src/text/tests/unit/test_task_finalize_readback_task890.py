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
