"""TASK-530 (D-08) — the worker process sweeps its idle entailer.

The MiniCheck entailer is loaded by an ACTIVITY, so its weights live in the
Temporal **worker** process, not in the FastAPI app. Lazy eviction on the next
`load_minicheck_entailer` covers a worker that keeps verifying; this periodic
sweep covers the one that ran a document and then went quiet — the exact case
where the pre-TASK-530 module dict pinned a GGUF forever.

Hermetic: no Temporal, no weights. Only the sweep body is tested; the interval
loop around it is trivial glue.

RED: written before the implementation.
"""

from __future__ import annotations

import pytest

from harness.temporal import worker as worker_module


@pytest.mark.asyncio
async def test_sweep_once_reports_released_entailers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "harness.sensors.inferential.minicheck_entailer.sweep_entailer_cache",
        lambda: 2,
    )

    assert await worker_module._sweep_model_caches_once() == 2


@pytest.mark.asyncio
async def test_sweep_once_never_raises_into_the_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A sweep failure must never take the worker down mid-poll."""

    def boom() -> int:
        raise RuntimeError("nvml gone")

    monkeypatch.setattr(
        "harness.sensors.inferential.minicheck_entailer.sweep_entailer_cache", boom
    )

    assert await worker_module._sweep_model_caches_once() == 0
