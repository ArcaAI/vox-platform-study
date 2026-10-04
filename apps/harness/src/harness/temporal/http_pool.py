"""TASK-1038 R-6 — ONE shared ``httpx.AsyncClient`` per process (per event loop).

``ApiClient`` and ``TextClient`` used to build a new ``httpx.AsyncClient`` — a new connection
pool, a new TCP (and TLS) handshake — for every request and close it straight after. A worker
running a graph makes dozens of gateway calls per node (resolve, credential, trajectory,
composed-prompt record, persist), so every one of them paid a fresh connection.

They now BORROW the process-wide client from here. The worker closes it on shutdown
(:func:`aclose_shared_clients`).

Two deliberate details:

* **Per event loop, not per process.** An httpx pool's connections belong to the loop that opened
  them; the unit suite runs one loop per test and the FastAPI app and the worker each run their
  own. A loop that has gone away simply drops out of the weak map.
* **An injected ``transport`` bypasses the pool.** Every unit suite in this package hands the
  clients an ``httpx.MockTransport``; those keep a private per-request client exactly as before,
  so test isolation is unchanged and no test can leak a mock into the shared pool.

Per-request timeouts are passed on each request (``client.get(..., timeout=...)``), because one
shared client serves callers with different budgets.
"""

from __future__ import annotations

import asyncio
import contextlib
import weakref
from collections.abc import AsyncIterator

import httpx

_CLIENTS: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, httpx.AsyncClient] = (
    weakref.WeakKeyDictionary()
)


def _build_client() -> httpx.AsyncClient:
    """The shared client. A seam so the unit suite can count how many get built."""
    return httpx.AsyncClient()


def shared_client() -> httpx.AsyncClient:
    """The running loop's shared client, built on first use (and rebuilt once closed)."""
    loop = asyncio.get_running_loop()
    client = _CLIENTS.get(loop)
    if client is None or client.is_closed:
        client = _build_client()
        _CLIENTS[loop] = client
    return client


@contextlib.asynccontextmanager
async def borrow(
    transport: httpx.AsyncBaseTransport | None, timeout: float
) -> AsyncIterator[httpx.AsyncClient]:
    """The client a request should use: the shared one, or a private one for an injected
    transport (closed on exit, exactly as before). Never closes the shared client."""
    if transport is not None:
        async with httpx.AsyncClient(transport=transport, timeout=timeout) as private:
            yield private
        return
    yield shared_client()


async def aclose_shared_clients() -> None:
    """Close every shared client this process opened. Called by the worker on shutdown."""
    clients = list(_CLIENTS.values())
    _CLIENTS.clear()
    for client in clients:
        if not client.is_closed:
            with contextlib.suppress(Exception):
                await client.aclose()


def reset_for_tests() -> None:
    """Forget every pooled client without awaiting (the unit suite's per-test reset)."""
    _CLIENTS.clear()
