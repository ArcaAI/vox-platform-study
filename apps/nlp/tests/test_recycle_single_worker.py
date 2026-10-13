"""A lone NLP process must not recycle itself on a request count.

On the cluster the pod runs ONE uvicorn process: a request-count recycle exits
the container, and every model reloads while probes fail — mid-consultation.
The RSS ceiling stays the leak backstop; ``0`` disables either recycle.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _reset():
    from nlp.core import bounds, recycle

    bounds.reset_bounds()
    recycle.reset_recycle_guard()
    yield
    bounds.reset_bounds()
    recycle.reset_recycle_guard()


def _guard(rss_mib: float, worker_count: int, **limits):
    from nlp.core import bounds, recycle

    bounds.set_bounds(**limits)
    fired: list[str] = []
    g = recycle.RecycleGuard(
        rss_reader=lambda: rss_mib, shutdown=fired.append, worker_count=worker_count
    )
    return g, fired


def test_single_worker_never_recycles_on_request_count():
    g, fired = _guard(100, worker_count=1, recycle_after_requests=3)
    for _ in range(10):
        g.after_response()
    assert fired == []


def test_single_worker_still_recycles_on_rss():
    g, fired = _guard(7000, worker_count=1, recycle_rss_mib=6144)
    g.after_response()
    assert fired == ["rss"]


def test_multi_worker_recycles_on_request_count():
    g, fired = _guard(100, worker_count=2, recycle_after_requests=3)
    for _ in range(3):
        g.after_response()
    assert fired == ["requests"]


def test_zero_disables_both_recycles():
    g, fired = _guard(99999, worker_count=4, recycle_after_requests=0, recycle_rss_mib=0)
    for _ in range(5):
        g.after_response()
    assert fired == []


def test_control_plane_zero_is_honoured_as_disabled():
    from nlp.core import bounds

    class _Snap:
        def setting(self, key):
            return {"nlp.worker.recycleAfterRequests": 0, "nlp.worker.recycleRssMib": 0}.get(key)

    b = bounds.apply_snapshot(_Snap())  # type: ignore[arg-type]
    assert (b.recycle_after_requests, b.recycle_rss_mib) == (0, 0)


def test_default_guard_reads_worker_count_from_settings(monkeypatch):
    from nlp.core import recycle
    from nlp.core.config import settings

    monkeypatch.setattr(settings.service, "workers", 1)
    fired: list[str] = []
    from nlp.core import bounds

    bounds.set_bounds(recycle_after_requests=1)
    g = recycle.RecycleGuard(rss_reader=lambda: 1.0, shutdown=fired.append)
    g.after_response()
    g.after_response()
    assert fired == []


def test_uvicorn_request_limit_only_with_several_workers():
    from nlp.main import uvicorn_max_requests

    assert uvicorn_max_requests(workers=1, after_requests=2000) is None
    assert uvicorn_max_requests(workers=4, after_requests=2000) == 2000
    assert uvicorn_max_requests(workers=4, after_requests=0) is None
