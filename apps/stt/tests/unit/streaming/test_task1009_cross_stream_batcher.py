"""TASK-1009 — the cross-stream batch scheduler.

``CrossStreamBatcher`` collects decode requests from CONCURRENT sessions that
share one loaded model and runs them as ONE batched decode: it flushes a group
when it reaches ``max_batch_size`` or when its oldest request has waited
``max_wait_ms``, then fans each result back to its own caller's future.

Everything here runs against a fake ``decode_batch`` — the scheduler is
engine-agnostic by construction, so no model weights are involved.
"""

from __future__ import annotations

import concurrent.futures
import threading
import time
from typing import Any

import pytest

from stt.streaming.cross_stream_batcher import (
    BatchQueueFullError,
    CrossStreamBatcher,
)

#: Generous upper bound for "resolves promptly" — the scheduler's own waits in
#: these tests are milliseconds; this only guards against a hung flusher.
_RESOLVE_TIMEOUT_S = 5.0


class _RecordingDecoder:
    """A fake ``decode_batch``: records each call and echoes ``<payload>:ok``."""

    def __init__(self, *, block: threading.Event | None = None) -> None:
        self.calls: list[tuple[Any, list[Any]]] = []
        self._block = block
        self.entered = threading.Event()
        self._lock = threading.Lock()

    def __call__(self, key: Any, payloads: list[Any]) -> list[Any]:
        with self._lock:
            self.calls.append((key, list(payloads)))
        self.entered.set()
        if self._block is not None:
            self._block.wait(_RESOLVE_TIMEOUT_S)
        return [f"{p}:ok" for p in payloads]


def _results(futures: list[concurrent.futures.Future]) -> list[Any]:
    return [f.result(timeout=_RESOLVE_TIMEOUT_S) for f in futures]


@pytest.fixture
def batchers():
    created: list[CrossStreamBatcher] = []

    def make(decode, **kwargs) -> CrossStreamBatcher:
        kwargs.setdefault("max_batch_size", 4)
        kwargs.setdefault("max_wait_ms", 5_000)
        kwargs.setdefault("max_queue", 64)
        batcher = CrossStreamBatcher(decode, name="test-model", **kwargs)
        created.append(batcher)
        return batcher

    yield make
    for batcher in created:
        batcher.close()


class TestBatchFormation:
    def test_requests_ready_together_decode_in_one_call(self, batchers) -> None:
        decoder = _RecordingDecoder()
        batcher = batchers(decoder, max_batch_size=4, max_wait_ms=5_000)

        futures = [batcher.submit("k", f"s{i}") for i in range(4)]

        assert _results(futures) == ["s0:ok", "s1:ok", "s2:ok", "s3:ok"]
        assert len(decoder.calls) == 1
        assert decoder.calls[0] == ("k", ["s0", "s1", "s2", "s3"])

    def test_a_full_batch_does_not_wait_for_max_wait(self, batchers) -> None:
        decoder = _RecordingDecoder()
        batcher = batchers(decoder, max_batch_size=2, max_wait_ms=60_000)

        start = time.monotonic()
        futures = [batcher.submit("k", "a"), batcher.submit("k", "b")]
        assert _results(futures) == ["a:ok", "b:ok"]

        assert time.monotonic() - start < 2.0

    def test_a_partial_batch_flushes_after_max_wait(self, batchers) -> None:
        decoder = _RecordingDecoder()
        batcher = batchers(decoder, max_batch_size=8, max_wait_ms=30)

        futures = [batcher.submit("k", "a"), batcher.submit("k", "b")]

        assert _results(futures) == ["a:ok", "b:ok"]
        assert [len(p) for _k, p in decoder.calls] == [2]

    def test_a_batch_never_exceeds_max_batch_size(self, batchers) -> None:
        block = threading.Event()
        decoder = _RecordingDecoder(block=block)
        batcher = batchers(decoder, max_batch_size=3, max_wait_ms=10)

        first = batcher.submit("k", "p0")
        assert decoder.entered.wait(_RESOLVE_TIMEOUT_S)
        rest = [batcher.submit("k", f"p{i}") for i in range(1, 8)]
        block.set()

        assert _results([first, *rest]) == [f"p{i}:ok" for i in range(8)]
        assert max(len(p) for _k, p in decoder.calls) <= 3
        # FIFO: arrival order is preserved across the batches.
        assert [p for _k, ps in decoder.calls for p in ps] == [f"p{i}" for i in range(8)]


class TestGrouping:
    def test_incompatible_keys_never_share_a_decode(self, batchers) -> None:
        decoder = _RecordingDecoder()
        batcher = batchers(decoder, max_batch_size=4, max_wait_ms=20)

        fa = [batcher.submit(("ml", "transcribe"), f"a{i}") for i in range(2)]
        fb = [batcher.submit(("en", "translate"), f"b{i}") for i in range(2)]

        assert _results(fa) == ["a0:ok", "a1:ok"]
        assert _results(fb) == ["b0:ok", "b1:ok"]
        keys_by_call = dict(decoder.calls)
        assert keys_by_call == {
            ("ml", "transcribe"): ["a0", "a1"],
            ("en", "translate"): ["b0", "b1"],
        }


class TestErrorIsolation:
    def test_a_per_item_exception_fails_only_its_own_caller(self, batchers) -> None:
        def decode(_key, payloads):
            return [ValueError(p) if p == "bad" else f"{p}:ok" for p in payloads]

        batcher = batchers(decode, max_batch_size=3)
        ok1, bad, ok2 = (batcher.submit("k", p) for p in ("x", "bad", "y"))

        assert ok1.result(timeout=_RESOLVE_TIMEOUT_S) == "x:ok"
        assert ok2.result(timeout=_RESOLVE_TIMEOUT_S) == "y:ok"
        with pytest.raises(ValueError, match="bad"):
            bad.result(timeout=_RESOLVE_TIMEOUT_S)

    def test_a_whole_batch_failure_is_retried_item_by_item(self, batchers) -> None:
        calls: list[list[str]] = []

        def decode(_key, payloads):
            calls.append(list(payloads))
            if "poison" in payloads:
                raise RuntimeError("batch kernel failed")
            return [f"{p}:ok" for p in payloads]

        batcher = batchers(decode, max_batch_size=3)
        futures = [batcher.submit("k", p) for p in ("a", "poison", "b")]

        assert futures[0].result(timeout=_RESOLVE_TIMEOUT_S) == "a:ok"
        assert futures[2].result(timeout=_RESOLVE_TIMEOUT_S) == "b:ok"
        with pytest.raises(RuntimeError, match="batch kernel failed"):
            futures[1].result(timeout=_RESOLVE_TIMEOUT_S)
        assert calls == [["a", "poison", "b"], ["a"], ["poison"], ["b"]]

    def test_a_result_count_mismatch_is_a_batch_failure(self, batchers) -> None:
        def decode(_key, payloads):
            return ["only-one"] if len(payloads) > 1 else [f"{payloads[0]}:ok"]

        batcher = batchers(decode, max_batch_size=2)
        futures = [batcher.submit("k", "a"), batcher.submit("k", "b")]

        assert _results(futures) == ["a:ok", "b:ok"]


class TestBoundsAndLifecycle:
    def test_a_full_queue_refuses_new_work_immediately(self, batchers) -> None:
        block = threading.Event()
        decoder = _RecordingDecoder(block=block)
        batcher = batchers(decoder, max_batch_size=1, max_wait_ms=0, max_queue=2)

        in_flight = batcher.submit("k", "running")
        assert decoder.entered.wait(_RESOLVE_TIMEOUT_S)
        queued = [batcher.submit("k", "q1"), batcher.submit("k", "q2")]

        with pytest.raises(BatchQueueFullError):
            batcher.submit("k", "overflow")

        block.set()
        assert _results([in_flight, *queued]) == ["running:ok", "q1:ok", "q2:ok"]
        assert batcher.queue_depth == 0

    def test_a_cancelled_request_is_never_decoded(self, batchers) -> None:
        block = threading.Event()
        decoder = _RecordingDecoder(block=block)
        batcher = batchers(decoder, max_batch_size=1, max_wait_ms=0)

        running = batcher.submit("k", "running")
        assert decoder.entered.wait(_RESOLVE_TIMEOUT_S)
        abandoned = batcher.submit("k", "abandoned")
        assert abandoned.cancel()
        kept = batcher.submit("k", "kept")
        block.set()

        assert _results([running, kept]) == ["running:ok", "kept:ok"]
        decoded = [p for _k, ps in decoder.calls for p in ps]
        assert "abandoned" not in decoded

    def test_close_fails_pending_work_and_refuses_new_work(self, batchers) -> None:
        block = threading.Event()
        decoder = _RecordingDecoder(block=block)
        batcher = batchers(decoder, max_batch_size=1, max_wait_ms=0)

        running = batcher.submit("k", "running")
        assert decoder.entered.wait(_RESOLVE_TIMEOUT_S)
        pending = batcher.submit("k", "pending")

        closer = threading.Thread(target=batcher.close)
        closer.start()
        block.set()
        closer.join(_RESOLVE_TIMEOUT_S)

        assert running.result(timeout=_RESOLVE_TIMEOUT_S) == "running:ok"
        with pytest.raises(RuntimeError, match="closed"):
            pending.result(timeout=_RESOLVE_TIMEOUT_S)
        with pytest.raises(RuntimeError, match="closed"):
            batcher.submit("k", "late")

    def test_configure_changes_the_limits_for_later_batches(self, batchers) -> None:
        decoder = _RecordingDecoder()
        batcher = batchers(decoder, max_batch_size=1, max_wait_ms=5_000)

        batcher.configure(max_batch_size=3, max_wait_ms=5_000, max_queue=64)
        futures = [batcher.submit("k", f"p{i}") for i in range(3)]

        assert _results(futures) == ["p0:ok", "p1:ok", "p2:ok"]
        assert [len(ps) for _k, ps in decoder.calls] == [3]

    @pytest.mark.parametrize(
        "limits",
        [
            {"max_batch_size": 0, "max_wait_ms": 10, "max_queue": 4},
            {"max_batch_size": 2, "max_wait_ms": -1, "max_queue": 4},
            {"max_batch_size": 2, "max_wait_ms": 10, "max_queue": 0},
        ],
    )
    def test_nonsense_limits_are_refused(self, limits) -> None:
        with pytest.raises(ValueError):
            CrossStreamBatcher(lambda _k, ps: ps, name="x", **limits)


class TestObservability:
    def test_observer_sees_batch_size_queue_wait_decode_time_and_depth(self, batchers) -> None:
        seen: dict[str, list[Any]] = {"batches": [], "depths": []}

        class _Observer:
            def batch_decoded(self, *, size: int, queue_waits_s: list[float], decode_s: float):
                seen["batches"].append((size, queue_waits_s, decode_s))

            def queue_depth(self, depth: int) -> None:
                seen["depths"].append(depth)

        def decode(_key, payloads):
            time.sleep(0.02)
            return list(payloads)

        batcher = batchers(decode, max_batch_size=2, observer=_Observer())
        _results([batcher.submit("k", "a"), batcher.submit("k", "b")])

        assert len(seen["batches"]) == 1
        size, waits, decode_s = seen["batches"][0]
        assert size == 2
        assert len(waits) == 2 and all(w >= 0.0 for w in waits)
        assert decode_s >= 0.02
        assert seen["depths"][-1] == 0
        assert max(seen["depths"]) >= 1
