"""TaskManager — Redis-backed task state + Redis Streams for chunk persistence."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Any, cast

import structlog

from smr.models.stream import StreamChunk
from smr.models.task import TaskState, TaskStatus

logger = structlog.get_logger(__name__)

_TASK_KEY_PREFIX = "smr:task:"
_STREAM_KEY_PREFIX = "smr:stream:"

_UPDATE_TASK_LUA = """
local key = KEYS[1]
local updates_json = ARGV[1]
local ttl = tonumber(ARGV[2])

local raw = redis.call('GET', key)
if not raw then
    return nil
end

local task = cjson.decode(raw)
local updates = cjson.decode(updates_json)

for k, v in pairs(updates) do
    task[k] = v
end

local updated_json = cjson.encode(task)
redis.call('SET', key, updated_json, 'EX', ttl)
return updated_json
"""


class TaskManager:
    """Manages task lifecycle and chunk streaming via Redis."""

    def __init__(self, redis: Any, task_ttl: int = 3600, stream_max_len: int = 10_000) -> None:
        self._redis = redis
        self._task_ttl = task_ttl
        self._stream_max_len = stream_max_len

    def _task_key(self, task_id: str) -> str:
        return f"{_TASK_KEY_PREFIX}{task_id}"

    def _stream_key(self, task_id: str) -> str:
        return f"{_STREAM_KEY_PREFIX}{task_id}"

    async def create_task(self, provider: str, model: str, max_retries: int = 3) -> TaskState:
        task_id = str(uuid.uuid4())
        state = TaskState(
            task_id=task_id,
            status=TaskStatus.PENDING,
            provider=provider,
            model=model,
            max_retries=max_retries,
            created_at=datetime.now(UTC),
        )
        await self._redis.set(
            self._task_key(task_id),
            state.model_dump_json(),
            ex=self._task_ttl,
        )
        return state

    async def get_task(self, task_id: str) -> TaskState | None:
        raw = await self._redis.get(self._task_key(task_id))
        if raw is None:
            return None
        return TaskState.model_validate_json(raw)

    async def update_task(self, task_id: str, **updates: Any) -> TaskState | None:
        result = await self._redis.eval(
            _UPDATE_TASK_LUA,
            1,
            self._task_key(task_id),
            json.dumps(updates, default=str),
            str(self._task_ttl),
        )
        if result is None:
            return None
        if isinstance(result, bytes):
            result = result.decode()
        return TaskState.model_validate_json(result)

    async def cancel_task(self, task_id: str) -> TaskState | None:
        return await self.update_task(task_id, status=TaskStatus.CANCELLED)

    async def append_chunk(self, task_id: str, chunk: StreamChunk) -> str:
        msg_id = await self._redis.xadd(
            self._stream_key(task_id),
            {"data": chunk.model_dump_json()},
            maxlen=self._stream_max_len,
        )
        return cast(str, msg_id)

    async def get_chunks(self, task_id: str, after_id: str | None = None) -> list[StreamChunk]:
        start = f"({after_id}" if after_id else "-"
        entries = await self._redis.xrange(self._stream_key(task_id), min=start, max="+")
        chunks = []
        for _msg_id, fields in entries:
            raw = fields.get(b"data") or fields.get("data")
            if raw:
                if isinstance(raw, bytes):
                    raw = raw.decode()
                chunks.append(StreamChunk.model_validate_json(raw))
        return chunks

    async def read_chunks_blocking(
        self, task_id: str, last_id: str = "0-0", block_ms: int = 5000
    ) -> list[tuple[str, StreamChunk]]:
        """Block-read new chunks from the stream via XREAD BLOCK.

        Returns list of (msg_id, chunk) tuples. Returns empty list on timeout.
        """
        stream_key = self._stream_key(task_id)
        result = await self._redis.xread(
            {stream_key: last_id},
            block=block_ms,
            count=100,
        )
        if not result:
            return []

        chunks: list[tuple[str, StreamChunk]] = []
        for _stream_name, entries in result:
            for msg_id, fields in entries:
                raw = fields.get(b"data") or fields.get("data")
                if raw:
                    if isinstance(raw, bytes):
                        raw = raw.decode()
                    if isinstance(msg_id, bytes):
                        msg_id = msg_id.decode()
                    chunks.append((msg_id, StreamChunk.model_validate_json(raw)))
        return chunks
