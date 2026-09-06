"""TASK-890 F6 — a wedged volume must cost ONE probe, not the service's readiness.

F3 moved the resolvability check off the event loop and put a wall-clock budget
around it, guarded by a ``BoundedSemaphore(1)`` so a stalled filesystem could
strand at most one worker thread. Measured on a clean restart 2026-09-07, that
turned a hung service into a permanently useless one: the FIRST probe on both
``stt`` and ``nlp`` never returned, held the only slot, and every probe after it
answered in 2 ms with ``an earlier probe on this host has not returned``. The
service stayed up and stayed unable to answer the one question it exists to
answer, until a restart.

What this suite pins:

* a stranded probe does NOT refuse the next one — the next is attempted and can
  still measure;
* only when every thread this process allows is stranded does the answer become
  ``degraded``, naming the stalled count and the cache root;
* when an abandoned thread eventually returns, the count comes back down and its
  TRUE duration is logged — the number that is otherwise unknowable;
* the boot warm-up touches every root once, off the request path, and reports
  ``warm`` honestly (including ``False`` when even the warm-up did not return);
* every filesystem call names itself BEFORE entering, because a call wedged in
  the kernel never returns to be timed.

Hermetic: no test touches a real model cache, and every blocking worker is
released in teardown so no stranded thread outlives its test.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time

import pytest

from hope_runtime_models import resolvable as rm
from hope_runtime_models.resolvable import (
    MAX_PROBE_THREADS,
    ResolvableQuery,
    ResolvableResult,
    check_resolvable_many,
    clear_resolvable_cache,
    probe_state,
    reset_probe_state,
    reset_warmup_state,
    warm_cache_roots,
    warmup_state,
)


def q(row_id: str) -> ResolvableQuery:
    return ResolvableQuery(id=row_id, source_uri=f"org/{row_id}")


@pytest.fixture
def gate():
    """One event every blocking worker waits on. Released in teardown, always.

    A test that stranded a thread past its own end would leak it into the next
    test's counts, which is precisely the failure mode under test.
    """
    event = threading.Event()
    yield event
    event.set()
    _drain()


def _drain(timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and probe_state()[0] > 0:
        time.sleep(0.01)
    reset_probe_state()


@pytest.fixture(autouse=True)
def _fresh():
    clear_resolvable_cache()
    reset_probe_state()
    reset_warmup_state()
    yield
    clear_resolvable_cache()
    reset_probe_state()
    reset_warmup_state()


def _selective(gate: threading.Event):
    """Blocks only on rows whose id starts with `stuck`; measures everything else."""

    def _check(query, *, hf_cache_dir=None, s3_cache_dir=None):  # noqa: ARG001
        if (query.id or "").startswith("stuck"):
            gate.wait(10)
        return ResolvableResult(query.id, True, "hf_cache", "measured", None)

    return _check


class TestAStrandedProbeDoesNotDisableTheNextOne:
    async def test_the_next_probe_is_attempted_and_can_still_measure(self, gate, monkeypatch):
        """The F6 defect, stated as a test.

        Under the one-slot guard the second call never ran at all: it answered
        `an earlier probe on this host has not returned` in ~2 ms, forever.
        """
        monkeypatch.setattr(rm, "_check", _selective(gate))

        stalled = await check_resolvable_many([q("stuck1")], budget_seconds=0.2)
        assert [r.resolvable for r in stalled] == [None]
        assert stalled[0].state == "timeout"

        measured = await check_resolvable_many([q("ok")], budget_seconds=5.0)

        assert measured[0].resolvable is True
        assert measured[0].state == "hf_cache"

    async def test_the_stalled_thread_is_counted(self, gate, monkeypatch):
        monkeypatch.setattr(rm, "_check", _selective(gate))

        await check_resolvable_many([q("stuck1")], budget_seconds=0.2)

        inflight, stalled = probe_state()
        assert (inflight, stalled) == (1, 1)


class TestTheCap:
    async def test_at_the_cap_the_answer_is_degraded(self, gate, monkeypatch, tmp_path):
        monkeypatch.setattr(rm, "_check", _selective(gate))
        for index in range(MAX_PROBE_THREADS):
            await check_resolvable_many([q(f"stuck{index}")], budget_seconds=0.2)
        assert probe_state() == (MAX_PROBE_THREADS, MAX_PROBE_THREADS)

        results = await check_resolvable_many(
            [q("a"), q("b")], hf_cache_dir=str(tmp_path), budget_seconds=5.0
        )

        assert [r.resolvable for r in results] == [None, None]
        assert {r.state for r in results} == {"degraded"}
        # The count and the root, so an operator knows WHICH volume stopped.
        assert f"{MAX_PROBE_THREADS} of this host's" in results[0].detail
        assert str(tmp_path) in results[0].detail
        assert results[0].path == str(tmp_path)

    async def test_it_never_starts_more_threads_than_the_cap(self, gate, monkeypatch):
        monkeypatch.setattr(rm, "_check", _selective(gate))

        for index in range(MAX_PROBE_THREADS + 4):
            await check_resolvable_many([q(f"stuck{index}")], budget_seconds=0.05)

        assert probe_state()[0] == MAX_PROBE_THREADS


class TestTheCountFallsWhenTheWorkerReturns:
    async def test_the_counter_decrements_and_the_true_duration_is_logged(
        self, gate, monkeypatch, caplog
    ):
        monkeypatch.setattr(rm, "_check", _selective(gate))
        await check_resolvable_many([q("stuck1")], budget_seconds=0.2)
        assert probe_state() == (1, 1)

        with caplog.at_level(logging.WARNING, logger=rm.logger.name):
            gate.set()
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline and probe_state()[0] > 0:
                await asyncio.sleep(0.01)

        assert probe_state() == (0, 0)
        assert any(
            "resolvable_abandoned_probe_returned" in record.getMessage()
            and "true_duration=" in record.getMessage()
            for record in caplog.records
        )

    async def test_a_probe_measures_again_once_the_volume_answers(self, gate, monkeypatch):
        monkeypatch.setattr(rm, "_check", _selective(gate))
        for index in range(MAX_PROBE_THREADS):
            await check_resolvable_many([q(f"stuck{index}")], budget_seconds=0.1)
        degraded = await check_resolvable_many([q("a")], budget_seconds=1.0)
        assert degraded[0].state == "degraded"

        gate.set()
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and probe_state()[0] > 0:
            await asyncio.sleep(0.01)

        recovered = await check_resolvable_many([q("a")], budget_seconds=5.0)
        assert recovered[0].resolvable is True


class TestTheWarmUp:
    async def test_it_is_pending_until_it_has_run(self):
        assert warmup_state() == "pending"

    async def test_it_touches_every_root_once_and_reports_warm(self, tmp_path, monkeypatch, caplog):
        (tmp_path / "hub").mkdir()
        # Every op logs, so the touches are observable rather than inferred.
        monkeypatch.setattr(rm, "SLOW_OP_SECONDS", 0.0)

        with caplog.at_level(logging.WARNING, logger=rm.logger.name):
            state = await warm_cache_roots(hf_cache_dir=str(tmp_path), budget_seconds=10.0)

        assert state is True
        assert warmup_state() is True
        messages = [record.getMessage() for record in caplog.records]
        assert any(f"op=warmup_stat path={tmp_path}" in message for message in messages)
        assert any(f"op=warmup_scandir path={tmp_path}" in message for message in messages)

    async def test_a_stalled_warm_up_reports_false_inside_its_own_budget(
        self, gate, monkeypatch, tmp_path
    ):
        monkeypatch.setattr(rm, "_touch_roots", lambda roots: gate.wait(10) or [])

        started = time.monotonic()
        state = await warm_cache_roots(hf_cache_dir=str(tmp_path), budget_seconds=0.2)
        elapsed = time.monotonic() - started

        assert state is False
        assert warmup_state() is False
        assert elapsed < 3.0

    async def test_it_never_raises_when_the_touch_itself_fails(self, tmp_path):
        def _boom(_roots):
            raise RuntimeError("volume went away")

        original = rm._touch_roots
        rm._touch_roots = _boom
        try:
            state = await warm_cache_roots(hf_cache_dir=str(tmp_path), budget_seconds=1.0)
        finally:
            rm._touch_roots = original

        assert state is False
        assert warmup_state() is False


class TestTheFilesystemCallNamesItself:
    def test_the_op_is_published_before_the_call_returns(self):
        """A wedged syscall never returns, so it can only be named on the way IN."""
        seen: list[str] = []

        def _watch() -> None:
            time.sleep(0.05)
            seen.append(rm._describe_op(threading.main_thread().ident))

        watcher = threading.Thread(target=_watch)
        watcher.start()
        with rm._fs_op("stat", "/some/volume"):
            time.sleep(0.2)
        watcher.join(5)

        assert seen and "op=stat" in seen[0] and "path=/some/volume" in seen[0]

    def test_it_is_cleared_once_the_call_returns(self):
        with rm._fs_op("open", "/some/volume/refs/main"):
            pass

        assert rm._describe_op(threading.get_ident()) == "op=<none>"

    def test_a_slow_call_is_logged_with_its_path(self, monkeypatch, caplog):
        monkeypatch.setattr(rm, "SLOW_OP_SECONDS", 0.01)

        with (
            caplog.at_level(logging.WARNING, logger=rm.logger.name),
            rm._fs_op("scandir", "/slow/volume"),
        ):
            time.sleep(0.05)

        assert any(
            "resolvable_slow_fs_op" in record.getMessage()
            and "path=/slow/volume" in record.getMessage()
            for record in caplog.records
        )
