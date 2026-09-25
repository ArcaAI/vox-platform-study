"""BUG-015 — the worker singletons must be per-event-loop.

Each held loop-bound state across the Dramatiq worker's per-message event loops
(TASK-1006 removed the third, the SQLAlchemy engine, with the database layer):

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
