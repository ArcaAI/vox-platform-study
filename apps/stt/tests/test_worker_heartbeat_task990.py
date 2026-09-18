"""STT Dramatiq worker liveness heartbeat (TASK-990 F10).

The batch worker serves no HTTP, so there is no endpoint for a kubelet
``httpGet`` probe. Its manifest therefore probed **:9191** — dramatiq's
Prometheus exposition server, which the CLI runs in a SEPARATE forked process
from the workers. A `tcpSocket :9191` check proves the exporter fork is alive
and says nothing at all about whether any worker process is still consuming
`stt_batch`. A wedged worker was never restarted.

These tests pin the replacement: a per-process heartbeat file whose MTIME is
the signal, written from inside the worker process and deliberately WITHHELD
when the process can no longer make progress.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import pytest

from stt.worker import (
    HEARTBEAT_DIR,
    WorkerHeartbeat,
    WorkerHeartbeatMiddleware,
    WorkerHeartbeatSettings,
)

STALE = 10_000.0


class _FakeThread:
    """Stands in for a dramatiq ConsumerThread / WorkerThread."""

    def __init__(self, alive: bool = True) -> None:
        self._alive = alive

    def is_alive(self) -> bool:
        return self._alive


class _FakeWorker:
    def __init__(self, worker_threads: int = 2, *, consumer_alive: bool = True) -> None:
        self.consumers = {"stt_batch": _FakeThread(consumer_alive)}
        self.workers = [_FakeThread() for _ in range(worker_threads)]


class _Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def _make(
    tmp_path: Path, worker: _FakeWorker | None = None, **kw
) -> tuple[WorkerHeartbeat, _Clock]:
    clock = _Clock()
    hb = WorkerHeartbeat(
        worker or _FakeWorker(),
        directory=tmp_path / "hb",
        interval_s=kw.pop("interval_s", 15.0),
        stall_after_s=kw.pop("stall_after_s", 1200.0),
        clock=clock,
    )
    return hb, clock


def _age(path: Path, seconds: float) -> float:
    """Backdate the file so a later tick is provably a NEW write."""
    old = time.time() - seconds
    os.utime(path, (old, old))
    return path.stat().st_mtime


# ── the file advances ───────────────────────────────────────────────────────


def test_tick_creates_the_heartbeat_file(tmp_path: Path) -> None:
    hb, _ = _make(tmp_path)
    assert hb.tick() is True
    assert hb.path.exists()


def test_heartbeat_mtime_advances_on_every_tick(tmp_path: Path) -> None:
    """The MTIME is the signal — a tick that does not move it detects nothing."""
    hb, _ = _make(tmp_path)
    hb.tick()
    stale = _age(hb.path, STALE)

    assert hb.tick() is True
    assert hb.path.stat().st_mtime > stale


def test_run_writes_before_the_first_sleep(tmp_path: Path) -> None:
    """Otherwise the liveness probe races the first interval on a healthy worker."""
    hb, _ = _make(tmp_path, interval_s=3600.0)
    thread = threading.Thread(target=hb.run, daemon=True)
    thread.start()
    try:
        deadline = time.time() + 5.0
        while time.time() < deadline and not hb.path.exists():
            time.sleep(0.01)
        assert hb.path.exists(), "heartbeat must be written before the first interval elapses"
    finally:
        hb.stop()
        thread.join(timeout=5.0)


def test_path_is_per_process(tmp_path: Path) -> None:
    """`--processes N` forks N workers; one shared file lets a healthy fork mask a hung one."""
    hb, _ = _make(tmp_path)
    assert hb.path.name == str(os.getpid())
    assert hb.path.parent == tmp_path / "hb"


def test_stop_removes_the_file(tmp_path: Path) -> None:
    hb, _ = _make(tmp_path)
    hb.tick()
    hb.stop()
    assert not hb.path.exists()


# ── the file STOPS advancing ────────────────────────────────────────────────


def test_heartbeat_withheld_when_a_worker_thread_has_died(tmp_path: Path) -> None:
    worker = _FakeWorker(worker_threads=2)
    hb, _ = _make(tmp_path, worker)
    hb.tick()
    stale = _age(hb.path, STALE)

    worker.workers[0]._alive = False

    assert hb.tick() is False
    assert hb.path.stat().st_mtime == stale


def test_heartbeat_withheld_when_the_consumer_thread_has_died(tmp_path: Path) -> None:
    """No consumer means nothing is pulled off `stt_batch`, however alive the process looks."""
    worker = _FakeWorker(consumer_alive=False)
    hb, _ = _make(tmp_path, worker)

    assert hb.tick() is False
    assert not hb.path.exists()


def test_heartbeat_withheld_when_every_worker_thread_is_stalled(tmp_path: Path) -> None:
    """The wedge case: all threads in-flight past the stall threshold — no progress is possible."""
    worker = _FakeWorker(worker_threads=2)
    hb, clock = _make(tmp_path, worker, stall_after_s=1200.0)
    hb.tick()
    stale = _age(hb.path, STALE)

    hb.message_started(ident=101)
    hb.message_started(ident=102)
    clock.now += 1300.0

    assert hb.tick() is False
    assert hb.path.stat().st_mtime == stale


# ── and keeps advancing when it should ──────────────────────────────────────


def test_heartbeat_written_when_the_worker_is_idle(tmp_path: Path) -> None:
    """An idle queue is the normal state — it must never read as a wedge."""
    hb, clock = _make(tmp_path)
    hb.tick()
    stale = _age(hb.path, STALE)

    clock.now += 100_000.0

    assert hb.tick() is True
    assert hb.path.stat().st_mtime > stale


def test_heartbeat_written_when_only_some_threads_are_stalled(tmp_path: Path) -> None:
    """Deliberate: one stuck job must not restart a pod whose other threads still work."""
    worker = _FakeWorker(worker_threads=2)
    hb, clock = _make(tmp_path, worker, stall_after_s=1200.0)
    hb.tick()
    stale = _age(hb.path, STALE)

    hb.message_started(ident=101)
    clock.now += 1300.0

    assert hb.tick() is True
    assert hb.path.stat().st_mtime > stale


def test_heartbeat_written_when_threads_are_busy_but_within_the_threshold(tmp_path: Path) -> None:
    """A long-but-legal transcription is work, not a wedge."""
    worker = _FakeWorker(worker_threads=2)
    hb, clock = _make(tmp_path, worker, stall_after_s=1200.0)
    hb.tick()
    stale = _age(hb.path, STALE)

    hb.message_started(ident=101)
    hb.message_started(ident=102)
    clock.now += 900.0

    assert hb.tick() is True
    assert hb.path.stat().st_mtime > stale


def test_finished_messages_clear_the_stall_state(tmp_path: Path) -> None:
    worker = _FakeWorker(worker_threads=1)
    hb, clock = _make(tmp_path, worker, stall_after_s=1200.0)
    hb.message_started(ident=101)
    clock.now += 1300.0
    assert hb.tick() is False

    hb.message_finished(ident=101)
    assert hb.tick() is True


# ── failure semantics ───────────────────────────────────────────────────────


def test_tick_never_raises_when_the_file_cannot_be_written(tmp_path: Path) -> None:
    """A heartbeat write failure must not kill a worker that is processing correctly.

    It ages the file out instead, which restarts the pod — the intended outcome anyway.
    """
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory")
    hb = WorkerHeartbeat(
        _FakeWorker(),
        directory=blocker / "hb",
        interval_s=15.0,
        stall_after_s=1200.0,
    )

    assert hb.tick() is False  # and does not raise


# ── wiring: this is what makes it run under the `dramatiq` CLI ──────────────


def test_middleware_is_registered_on_the_module_broker() -> None:
    """The container runs `python -m dramatiq stt.worker`, NOT `stt.worker.main()`.

    The CLI imports this module and builds its own `Worker`, so anything started
    inside `main()` never runs in the deployed image. Registration must happen at
    module import, on the broker the CLI picks up.
    """
    import stt.worker as worker_module

    names = [type(m).__name__ for m in worker_module.broker.middleware]
    assert "WorkerHeartbeatMiddleware" in names


def test_middleware_starts_the_heartbeat_on_worker_boot(tmp_path: Path) -> None:
    middleware = WorkerHeartbeatMiddleware(
        WorkerHeartbeatSettings(directory=tmp_path / "hb", interval_s=3600.0)
    )
    worker = _FakeWorker()

    middleware.after_worker_boot(None, worker)
    try:
        heartbeat = middleware.heartbeat
        assert heartbeat is not None
        deadline = time.time() + 5.0
        while time.time() < deadline and not heartbeat.path.exists():
            time.sleep(0.01)
        assert heartbeat.path.exists()
    finally:
        middleware.before_worker_shutdown(None, worker)


def test_middleware_message_hooks_track_in_flight_work(tmp_path: Path) -> None:
    middleware = WorkerHeartbeatMiddleware(
        WorkerHeartbeatSettings(directory=tmp_path / "hb", interval_s=3600.0)
    )
    worker = _FakeWorker(worker_threads=1)
    middleware.after_worker_boot(None, worker)
    try:
        middleware.before_process_message(None, object())
        assert middleware.heartbeat is not None
        assert middleware.heartbeat.in_flight_count == 1

        middleware.after_process_message(None, object())
        assert middleware.heartbeat.in_flight_count == 0
    finally:
        middleware.before_worker_shutdown(None, worker)


# ── settings ────────────────────────────────────────────────────────────────


def test_settings_defaults_are_usable_without_any_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Liveness must work out of the box — an unset env var may not disable the probe."""
    for name in (
        "STT_WORKER_HEARTBEAT_DIRECTORY",
        "STT_WORKER_HEARTBEAT_INTERVAL_S",
        "STT_WORKER_HEARTBEAT_STALL_AFTER_S",
    ):
        monkeypatch.delenv(name, raising=False)

    settings = WorkerHeartbeatSettings()
    assert settings.directory == HEARTBEAT_DIR
    assert settings.interval_s == 15.0
    assert settings.stall_after_s > 0


def test_settings_are_overridable_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STT_WORKER_HEARTBEAT_DIRECTORY", "/tmp/elsewhere")
    monkeypatch.setenv("STT_WORKER_HEARTBEAT_INTERVAL_S", "5")

    settings = WorkerHeartbeatSettings()
    assert settings.directory == Path("/tmp/elsewhere")
    assert settings.interval_s == 5.0


# ── F11: the image's inherited HTTP healthcheck ─────────────────────────────


def _worker_stage_directives() -> list[str]:
    """The worker stage's Dockerfile directives, comments and blank lines stripped."""
    dockerfile = Path(__file__).resolve().parents[1] / "docker" / "Dockerfile"
    stage = dockerfile.read_text(encoding="utf-8").split("FROM ml-runtime AS worker", 1)[1]
    stage = stage.replace("\\\n", " ")  # join continuations
    return [
        line.strip()
        for line in stage.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


def test_worker_stage_overrides_the_inherited_http_healthcheck() -> None:
    """`FROM ml-runtime AS worker` inherits a HEALTHCHECK against :8861.

    The Dramatiq worker never binds 8861, so that container is permanently
    unhealthy under `docker run` / compose. The worker stage must declare its own.
    """
    directives = _worker_stage_directives()
    healthcheck = [line for line in directives if line.startswith("HEALTHCHECK")]
    assert (
        healthcheck
    ), "the worker stage must override ml-runtime's HTTP healthcheck — it can never pass"
    assert not any(
        "8861" in line for line in directives
    ), "the worker binds no HTTP port; its healthcheck must not probe one"


def test_worker_healthcheck_reads_the_heartbeat_directory() -> None:
    """The image-level check must use the same signal as the manifest's exec probe."""
    healthcheck = " ".join(
        line for line in _worker_stage_directives() if "HEALTHCHECK" in line or "find" in line
    )
    assert str(HEARTBEAT_DIR) in healthcheck
    assert "-mmin -1" in healthcheck, "freshness, not existence — an existence check passes forever"


# ── wiring, against REAL dramatiq ───────────────────────────────────────────


def test_real_dramatiq_worker_starts_and_stops_the_heartbeat(tmp_path: Path) -> None:
    """Drives an actual `dramatiq.Worker` (StubBroker, no Redis) rather than a fake.

    The fakes above pin the POLICY; this pins the WIRING — that
    `after_worker_boot` / `before_worker_shutdown` are the hooks dramatiq
    actually calls, with the signatures we declare. Get those wrong and every
    other test here still passes while the deployed worker never heartbeats.
    """
    from dramatiq.brokers.stub import StubBroker
    from dramatiq.worker import Worker

    broker = StubBroker()
    broker.emit_after("process_boot")
    middleware = WorkerHeartbeatMiddleware(
        WorkerHeartbeatSettings(directory=tmp_path / "hb", interval_s=3600.0)
    )
    broker.add_middleware(middleware)

    worker = Worker(broker, worker_threads=1)
    worker.start()
    try:
        assert middleware.heartbeat is not None
        path = middleware.heartbeat.path
        deadline = time.time() + 5.0
        while time.time() < deadline and not path.exists():
            time.sleep(0.01)
        assert path.exists(), "a booted dramatiq Worker must produce a heartbeat"

        # Real consumer/worker threads are alive, so a tick must still write.
        stale = _age(path, STALE)
        assert middleware.heartbeat.tick() is True
        assert path.stat().st_mtime > stale
    finally:
        worker.stop()
        broker.close()

    assert not path.exists(), "shutdown must remove the file so a lingering process is not 'live'"
