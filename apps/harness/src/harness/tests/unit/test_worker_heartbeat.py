"""Liveness heartbeat (TASK-625 W-10).

The manifest's livenessProbe execs `find /tmp/harness-worker-heartbeat -mmin -1`,
so the file's MTIME is the signal, not its existence. These tests pin the two
properties the probe actually depends on.
"""

from __future__ import annotations

import asyncio

import pytest

from harness.temporal.worker import _write_heartbeat_forever


@pytest.mark.asyncio
async def test_heartbeat_file_exists_before_the_first_interval_elapses(tmp_path):
    """Must write BEFORE sleeping, or the probe races startup on a healthy worker."""
    hb = tmp_path / "heartbeat"
    task = asyncio.create_task(_write_heartbeat_forever(path=hb, interval_s=60.0))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert hb.exists(), "heartbeat file must exist immediately, not one interval later"


@pytest.mark.asyncio
async def test_heartbeat_refreshes_mtime_on_every_tick(tmp_path):
    """The probe reads mtime — a write-once file would pass forever and detect nothing."""
    hb = tmp_path / "heartbeat"
    task = asyncio.create_task(_write_heartbeat_forever(path=hb, interval_s=0.05))
    await asyncio.sleep(0.02)
    first = hb.stat().st_mtime_ns
    await asyncio.sleep(0.2)
    second = hb.stat().st_mtime_ns
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert second > first, "mtime must advance each tick, else liveness never fails"


@pytest.mark.asyncio
async def test_write_failure_does_not_kill_the_worker(tmp_path):
    """A heartbeat write error must not take down a worker that is otherwise healthy.

    Points the heartbeat at a path under a FILE, so touch() raises NotADirectoryError.
    """
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory")
    task = asyncio.create_task(
        _write_heartbeat_forever(path=blocker / "heartbeat", interval_s=0.02)
    )
    await asyncio.sleep(0.1)

    assert not task.done(), "heartbeat loop must survive an unwritable path"
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
