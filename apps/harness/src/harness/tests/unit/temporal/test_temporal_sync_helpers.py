"""Regression tests for the workflow-test synchronisation helpers.

``await_query`` exists so a *slow* machine costs seconds instead of a red build.
It failed to deliver that: the SDK's default per-attempt RPC deadline (~10s) is a
third of the whole 30s budget, so three unlucky long-polls exhausted it and the
poll raised ``RPCError: query deadline exceeded`` while the workflow under test
was progressing perfectly well (observed in CI on a loaded runner, across a
``continue_as_new`` handover).

These tests pin the two properties that keep that from recurring — a short
per-attempt deadline, and a transient-tolerant retry loop — with a fake handle,
so they need no Temporal server.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from temporalio.service import RPCError, RPCStatusCode

from harness.tests.unit.temporal._temporal_sync import await_query


def _rpc_error(status: RPCStatusCode) -> RPCError:
    return RPCError("query deadline exceeded", status, b"")


class _FakeHandle:
    """Answers ``query`` with a scripted sequence of raises/values."""

    def __init__(self, script: list[Any]) -> None:
        self._script = list(script)
        self.rpc_timeouts: list[timedelta | None] = []

    async def query(self, query: Any, *, rpc_timeout: timedelta | None = None) -> Any:
        self.rpc_timeouts.append(rpc_timeout)
        outcome = self._script.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


class TestAwaitQueryAttemptDeadline:
    @pytest.mark.asyncio
    async def test_every_attempt_carries_a_short_rpc_timeout(self) -> None:
        """Without this the SDK default (~10s) applies and the budget buys 3 tries."""
        handle = _FakeHandle(["ready"])

        assert await await_query(handle, "state", lambda s: s == "ready") == "ready"

        assert handle.rpc_timeouts, "the helper must pass an explicit rpc_timeout"
        for timeout in handle.rpc_timeouts:
            assert timeout is not None
            assert timeout <= timedelta(
                seconds=5
            ), "a per-attempt deadline near the 30s budget defeats retrying"

    @pytest.mark.asyncio
    async def test_repeated_deadlines_are_retried_not_raised(self) -> None:
        """Five consecutive deadlines used to be impossible to survive."""
        handle = _FakeHandle(
            [_rpc_error(RPCStatusCode.DEADLINE_EXCEEDED)] * 5 + ["ready"],
        )

        assert await await_query(handle, "state", lambda s: s == "ready") == "ready"
        assert len(handle.rpc_timeouts) == 6

    @pytest.mark.asyncio
    async def test_a_non_transient_status_still_propagates(self) -> None:
        """Retrying must not paper over a real query error (bad name, handler raised)."""
        handle = _FakeHandle([_rpc_error(RPCStatusCode.INVALID_ARGUMENT)])

        with pytest.raises(RPCError):
            await await_query(handle, "state", lambda s: True)

    @pytest.mark.asyncio
    async def test_transient_errors_stop_at_the_budget(self) -> None:
        """The retry is bounded — an endlessly transient handle raises, never hangs."""
        handle = _FakeHandle([_rpc_error(RPCStatusCode.UNAVAILABLE)] * 200)

        with pytest.raises(RPCError):
            await await_query(handle, "state", lambda s: True, timeout=0.1, delay=0.01)
