"""TASK-818 Lane A / A-4 — Bedrock streams stop eating the default executor.

Bottleneck B-3, verbatim from the audit: `bedrock.py` bridged boto3's SYNCHRONOUS
`converse_stream` iterator onto the event loop with
``loop.run_in_executor(None, _iterate_stream)``, and that thread is held for the
ENTIRE duration of the stream — not for one call. `None` means asyncio's DEFAULT
executor, whose size is ``min(32, cpu_count + 4)``. So roughly 32 concurrent
Bedrock streams saturate it, and every other ``to_thread`` user in the process
then queues behind a set of threads that will not return until their generations
finish. That is a hard ceiling, and it is not even Bedrock's own ceiling: it is
imposed on everyone else.

The interim fix this lane ships (4.3) is a BOUNDED, DEDICATED pool sized to the
Bedrock concurrency the control plane already publishes, so:

  * Bedrock streams can never starve another subsystem, and
  * the pool is never the binding constraint, because it is sized to the same
    ``maxConcurrent`` that already bounds the provider semaphore.

The structural fix (SigV4-signed direct HTTP over the shared httpx client) is
explicitly NOT in this lane.

RED before implementation.
"""

from __future__ import annotations

import asyncio
import inspect
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock

import pytest

from text.models.requests import GenerateRequest
from text.models.stream import StreamChunk
from text.tests.conftest import stub_client


def _snapshot(profiles: list[dict]):
    from text.core.effective_config import EffectiveConfigSnapshot

    return EffectiveConfigSnapshot(raw={"runtimeProfiles": profiles}, ok=True)


class _RecordingEventStream:
    """Records the thread that iterated it, then behaves like boto3's stream."""

    def __init__(self, events: list[dict], seen: list[str]) -> None:
        self._events = list(events)
        self._seen = seen
        self._index = 0

    def __iter__(self):
        return self

    def __next__(self):
        self._seen.append(threading.current_thread().name)
        if self._index >= len(self._events):
            raise StopIteration
        event = self._events[self._index]
        self._index += 1
        return event


class TestDedicatedExecutor:
    def test_the_executor_exists_and_is_a_singleton(self):
        from text.providers.pool import bedrock_stream_executor

        first = bedrock_stream_executor()
        assert isinstance(first, ThreadPoolExecutor)
        assert bedrock_stream_executor() is first

    def test_it_is_never_the_default_executor(self):
        """`run_in_executor(None, ...)` is the defect. Naming the executor at the
        call site is what makes the boundary real rather than aspirational."""
        from text.providers import bedrock as mod

        source = inspect.getsource(mod)
        assert "run_in_executor(None" not in source
        assert "bedrock_stream_executor" in source

    def test_it_is_bounded(self):
        from text.providers.pool import bedrock_stream_executor

        assert bedrock_stream_executor()._max_workers > 0

    def test_it_floors_at_the_provider_concurrency_floor(self):
        from text.core.runtime_defaults import PROVIDER_MAX_CONCURRENT_FLOOR
        from text.providers.pool import apply_pool_policy, bedrock_stream_executor

        apply_pool_policy(_snapshot([]))
        assert bedrock_stream_executor()._max_workers >= PROVIDER_MAX_CONCURRENT_FLOOR

    def test_it_is_sized_from_the_control_plane_bedrock_concurrency(self):
        """Sized to the SAME ``maxConcurrent`` that bounds the provider semaphore,
        so the pool can never become the binding constraint (AC-8) and can never
        exceed the concurrency the platform already agreed to."""
        from text.providers.pool import apply_pool_policy, bedrock_stream_executor

        apply_pool_policy(
            _snapshot([{"provider": "bedrock", "modelSlug": "", "maxConcurrent": 128}])
        )
        assert bedrock_stream_executor()._max_workers == 128

    def test_growth_does_not_discard_a_pool_with_live_streams(self):
        """Raising the ceiling must not swap the executor out from under threads
        that are mid-stream - each of those threads owns a generation."""
        from text.providers.pool import apply_pool_policy, bedrock_stream_executor

        apply_pool_policy(_snapshot([{"provider": "bedrock", "modelSlug": "", "maxConcurrent": 8}]))
        before = bedrock_stream_executor()
        apply_pool_policy(
            _snapshot([{"provider": "bedrock", "modelSlug": "", "maxConcurrent": 64}])
        )
        after = bedrock_stream_executor()

        assert after is before
        assert after._max_workers == 64

    def test_only_bedrock_rows_size_it(self):
        from text.providers.pool import apply_pool_policy, bedrock_stream_executor

        apply_pool_policy(_snapshot([{"provider": "bedrock", "modelSlug": "", "maxConcurrent": 9}]))
        apply_pool_policy(
            _snapshot(
                [
                    {"provider": "bedrock", "modelSlug": "", "maxConcurrent": 9},
                    {"provider": "openai", "modelSlug": "", "maxConcurrent": 4096},
                ]
            )
        )
        assert bedrock_stream_executor()._max_workers == 9


class TestTheStreamActuallyRunsThere:
    @pytest.mark.asyncio
    async def test_the_stream_thread_belongs_to_the_dedicated_pool(self):
        """The assertion that would have caught B-3: the worker thread's name.
        asyncio's default executor names its threads ``asyncio_N``; ours carries
        the Bedrock prefix."""
        from text.providers.bedrock import BedrockProvider
        from text.providers.pool import BEDROCK_STREAM_THREAD_PREFIX

        provider = BedrockProvider()
        provider._client = stub_client(provider, MagicMock())
        seen: list[str] = []
        provider._client.converse_stream.return_value = {
            "stream": _RecordingEventStream(
                [
                    {"contentBlockDelta": {"delta": {"text": "hi"}}},
                    {"messageStop": {"stopReason": "end_turn"}},
                ],
                seen,
            )
        }

        chunks: list[StreamChunk] = []
        async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", model="m")):
            chunks.append(chunk)

        assert [c.content for c in chunks if c.type == "chunk"] == ["hi"]
        assert seen, "the stream was never iterated"
        assert all(name.startswith(BEDROCK_STREAM_THREAD_PREFIX) for name in seen), seen

    @pytest.mark.asyncio
    async def test_a_saturated_bedrock_pool_does_not_starve_other_to_thread_users(self):
        """The whole point of the boundary. Fill the Bedrock pool to its ceiling
        with streams that will not finish, then prove an unrelated
        ``asyncio.to_thread`` call still runs."""
        from text.providers import pool as pool_mod
        from text.providers.bedrock import BedrockProvider

        pool_mod.apply_pool_policy(
            _snapshot([{"provider": "bedrock", "modelSlug": "", "maxConcurrent": 2}])
        )
        release = threading.Event()

        class _BlockingStream:
            def __iter__(self):
                return self

            def __next__(self):
                release.wait(timeout=10)
                raise StopIteration

        def _spawn():
            provider = BedrockProvider()
            provider._client = stub_client(provider, MagicMock())
            provider._client.converse_stream.return_value = {"stream": _BlockingStream()}

            async def _drain():
                async for _ in provider.generate_stream(GenerateRequest(prompt="hi", model="m")):
                    pass

            return asyncio.create_task(_drain())

        held = [_spawn() for _ in range(2)]
        await asyncio.sleep(0.2)
        try:
            assert await asyncio.wait_for(asyncio.to_thread(lambda: "alive"), timeout=5) == "alive"
        finally:
            release.set()
            await asyncio.gather(*held, return_exceptions=True)
