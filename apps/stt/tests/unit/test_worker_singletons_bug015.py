"""BUG-015 — the three worker singletons must be per-event-loop.

Each held loop-bound state across the Dramatiq worker's per-message event loops:

  * ``connection._get_or_create_engine`` — a SQLAlchemy async engine whose pool
    holds asyncpg connections bound to the creating loop (keyed on ``id(loop)``,
    which recycles) AND was never disposed, so pools accumulated per job.
  * ``gateway.get_api_client`` — ``@lru_cache``'d, so ONE ``httpx.AsyncClient``
    was shared by every loop in the process.
  * ``effective_config.get_effective_config_client`` — a module global whose
    ``asyncio.Lock`` is bound to whichever loop first awaited it; the worker log
    showed it stuck as ``[unlocked, waiters:1]`` on a foreign loop.
"""

import asyncio

import pytest

from stt.core.loop_local import reset_loop_locals


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_loop_locals()
    yield
    reset_loop_locals()


class TestDatabaseEngineIsPerLoop:
    def test_each_loop_gets_its_own_engine(self) -> None:
        from stt.core.database.connection import _get_or_create_engine

        async def main() -> object:
            engine, _ = _get_or_create_engine()
            return engine

        assert asyncio.run(main()) is not asyncio.run(main())

    def test_engines_do_not_accumulate_across_jobs(self) -> None:
        """The leak that exhausted Postgres `max_connections` after ~24 jobs."""
        from stt.core.database.connection import _get_or_create_engine, engine_cache_size

        async def main() -> None:
            _get_or_create_engine()

        for _ in range(8):
            asyncio.run(main())

        assert engine_cache_size() <= 1


class TestApiClientIsPerLoop:
    def test_each_loop_gets_its_own_gateway_client(self) -> None:
        from stt.core.api_client.gateway import get_api_client

        async def main() -> object:
            return get_api_client()

        first, second = asyncio.run(main()), asyncio.run(main())
        assert first is not second

    def test_same_loop_reuses_the_gateway_client(self) -> None:
        from stt.core.api_client.gateway import get_api_client

        async def main() -> tuple[object, object]:
            return get_api_client(), get_api_client()

        first, second = asyncio.run(main())
        assert first is second


class TestEffectiveConfigClientIsPerLoop:
    def test_each_loop_gets_its_own_client_and_lock(self) -> None:
        from stt.core.effective_config import get_effective_config_client

        async def main() -> tuple[object, object]:
            client = get_effective_config_client()
            return client, client._lock

        (first, lock_a), (second, lock_b) = asyncio.run(main()), asyncio.run(main())
        assert first is not second
        assert lock_a is not lock_b, "a shared asyncio.Lock is the cross-loop defect"

    def test_same_loop_reuses_the_client(self) -> None:
        from stt.core.effective_config import get_effective_config_client

        async def main() -> tuple[object, object]:
            return get_effective_config_client(), get_effective_config_client()

        first, second = asyncio.run(main())
        assert first is second
