"""BUG-015 — process-wide singletons must not leak across event loops.

The Dramatiq worker runs one ``asyncio.run()`` per message, so a new event loop
is created and destroyed for every job. Anything cached process-wide that holds
loop-bound state (a SQLAlchemy async engine's pool, an ``httpx.AsyncClient``, an
``asyncio.Lock``) is therefore only valid for the loop that built it.

The pre-existing DB cache tried to honour that by keying on ``id(loop)`` — but
CPython recycles those addresses aggressively (measured: 47 distinct addresses
over 400 sequential ``asyncio.run()`` calls), so a new loop routinely collided
with a CLOSED loop's entry and got its dead pool back. Observed effect: a batch
job stalled 300s inside its first query before the dead socket timed out.

These tests pin the two invariants that fix it:
  1. a binding is reused ONLY by the exact loop object that created it, so a
     recycled address can never serve a dead loop's value; and
  2. bindings for closed loops are disposed and evicted, so a long-running
     worker does not accumulate one connection pool per job (measured: 24 jobs
     exhausted Postgres `max_connections`).
"""

import asyncio

import pytest

from stt.core.loop_local import get_loop_local, loop_local_size, reset_loop_locals


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_loop_locals()
    yield
    reset_loop_locals()


class TestLoopLocalBinding:
    def test_same_loop_reuses_the_value(self) -> None:
        async def main() -> tuple[object, object]:
            return (
                get_loop_local("db", lambda: object()),
                get_loop_local("db", lambda: object()),
            )

        first, second = asyncio.run(main())
        assert first is second

    def test_distinct_loops_get_distinct_values(self) -> None:
        async def main() -> object:
            return get_loop_local("db", lambda: object())

        assert asyncio.run(main()) is not asyncio.run(main())

    def test_namespaces_are_independent(self) -> None:
        async def main() -> tuple[object, object]:
            return (
                get_loop_local("db", lambda: object()),
                get_loop_local("http", lambda: object()),
            )

        db, http = asyncio.run(main())
        assert db is not http


class TestRecycledLoopAddress:
    """The defect itself: `id(loop)` is reused after a loop is garbage-collected."""

    def test_a_recycled_address_does_not_serve_the_dead_loops_value(self) -> None:
        disposed: list[object] = []
        dead_loop = asyncio.new_event_loop()
        dead_loop.close()
        stale = object()

        async def main() -> object:
            # Plant the stale binding under the RUNNING loop's id while the
            # binding itself belongs to `dead_loop` — exactly what an address
            # recycle produces, made deterministic.
            from stt.core import loop_local

            running = asyncio.get_running_loop()
            loop_local._REGISTRY[("db", id(running))] = loop_local._Binding(
                loop=dead_loop, value=stale, dispose=disposed.append
            )
            return get_loop_local("db", lambda: object(), dispose=disposed.append)

        fresh = asyncio.run(main())
        assert fresh is not stale, "a recycled address served a dead loop's value"
        assert disposed == [stale], "the stale binding must be disposed, not leaked"

    def test_closed_loop_bindings_are_pruned_and_disposed(self) -> None:
        disposed: list[object] = []

        async def main() -> None:
            get_loop_local("db", lambda: object(), dispose=disposed.append)

        for _ in range(5):
            asyncio.run(main())

        # Every prior loop is closed by now, so at most the newest binding
        # survives — the registry must not grow one entry per job.
        assert loop_local_size() <= 1
        assert len(disposed) >= 4

    def test_dispose_failure_never_breaks_the_caller(self) -> None:
        def boom(_value: object) -> None:
            raise RuntimeError("pool belongs to a closed loop")

        async def main() -> object:
            return get_loop_local("db", lambda: object(), dispose=boom)

        asyncio.run(main())
        assert asyncio.run(main()) is not None
