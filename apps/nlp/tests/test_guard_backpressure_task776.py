"""TASK-776 — guard routes batch, shed load explicitly, and say so in metrics.

Three properties, all of which the TASK-735 routes lacked:

1. **Coalescing** — concurrent `/guard/pii` calls that share a taxonomy and
   threshold ride ONE forward pass.
2. **Declared backpressure** — a full queue or a blown wait-ceiling is a
   **503 with `Retry-After`**, never an unbounded queue and never a fabricated
   empty result. (An empty PII list means "scanned, found nothing"; returning it
   under overload would silently disable redaction.)
3. **Observability** — queue depth, queue wait, batch size and rejections are on
   `/metrics`, so the ceilings can be tuned from evidence rather than folklore.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest

TENANT = "11111111-1111-1111-1111-111111111111"
MODEL = "acme/pii-detector"


@pytest.fixture(autouse=True)
def _fresh_dispatch():
    from nlp.services import guard_dispatch

    asyncio.run(guard_dispatch.reset_guard_batchers())
    yield
    asyncio.run(guard_dispatch.reset_guard_batchers())


def _fake_acquire(service):
    @asynccontextmanager
    async def _acquire(model_name, model_path=None):
        yield service

    return _acquire


class BatchingGuard:
    """Records how many forward passes the route actually issued."""

    def __init__(self, delay: float = 0.0) -> None:
        self.passes: list[int] = []
        self.delay = delay

    async def batch_extract_entities(self, texts, labels, threshold, batch_size=8):  # noqa: ANN001
        self.passes.append(len(texts))
        if self.delay:
            await asyncio.sleep(self.delay)
        return [[] for _ in texts]

    async def batch_classify_text(self, texts, tasks, threshold, batch_size=8):  # noqa: ANN001
        self.passes.append(len(texts))
        if self.delay:
            await asyncio.sleep(self.delay)
        return [{} for _ in texts]


def test_concurrent_pii_requests_share_one_forward_pass(client, monkeypatch) -> None:
    import nlp.api.v1.rest.guard as guard_module

    guard = BatchingGuard(delay=0.05)
    monkeypatch.setattr(guard_module, "_acquire_guard", _fake_acquire(guard))

    body = {"text": "hello", "model_name": MODEL, "labels": ["email"], "tenant_id": TENANT}

    import threading

    responses: list[int] = []
    lock = threading.Lock()

    def call() -> None:
        code = client.post("/api/v1/guard/pii", json=body).status_code
        with lock:
            responses.append(code)

    threads = [threading.Thread(target=call) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert responses == [200] * 8
    assert guard.passes, "no forward pass was issued"
    assert sum(guard.passes) == 8, f"every request must be served exactly once: {guard.passes}"
    assert (
        len(guard.passes) < 8
    ), f"requests did not coalesce — {len(guard.passes)} passes for 8 requests"


def test_a_full_queue_is_a_503_with_retry_after(client, monkeypatch) -> None:
    """Load shedding is a declared, retryable failure — never a silent empty result."""
    import nlp.api.v1.rest.guard as guard_module
    from nlp.core.batching import InferenceQueueFull

    async def boom(*args, **kwargs):  # noqa: ANN002, ANN003
        raise InferenceQueueFull("nlp_guard_pii: inference queue full (256 waiting)")

    monkeypatch.setattr(guard_module, "_acquire_guard", _fake_acquire(BatchingGuard()))
    monkeypatch.setattr(guard_module, "_submit_pii", boom)

    body = {"text": "hello", "model_name": MODEL, "labels": ["email"], "tenant_id": TENANT}
    response = client.post("/api/v1/guard/pii", json=body)

    assert response.status_code == 503
    assert response.headers.get("Retry-After")
    assert "queue" in response.json()["error"].lower()


def test_a_blown_wait_ceiling_is_a_503(client, monkeypatch) -> None:
    import nlp.api.v1.rest.guard as guard_module
    from nlp.core.batching import InferenceQueueTimeout

    async def boom(*args, **kwargs):  # noqa: ANN002, ANN003
        raise InferenceQueueTimeout("waited 21.0s, ceiling is 20.0s")

    monkeypatch.setattr(guard_module, "_acquire_guard", _fake_acquire(BatchingGuard()))
    monkeypatch.setattr(guard_module, "_submit_classify", boom)

    body = {
        "text": "hello",
        "model_name": MODEL,
        "tenant_id": TENANT,
        "tasks": {"prompt_safety": {"labels": ["safe", "unsafe"], "multi_label": False}},
    }
    response = client.post("/api/v1/guard/classify", json=body)
    assert response.status_code == 503
    assert response.headers.get("Retry-After")


def test_backpressure_metrics_are_exposed(client, monkeypatch) -> None:
    import nlp.api.v1.rest.guard as guard_module

    guard = BatchingGuard()
    monkeypatch.setattr(guard_module, "_acquire_guard", _fake_acquire(guard))
    body = {"text": "hello", "model_name": MODEL, "labels": ["email"], "tenant_id": TENANT}
    assert client.post("/api/v1/guard/pii", json=body).status_code == 200

    # `conftest` patches `setup_prometheus` off, so scrape the process-global
    # registry the exposition endpoint renders in production.
    from prometheus_client import REGISTRY, generate_latest

    metrics = generate_latest(REGISTRY).decode()
    for family in (
        "nlp_inference_queue_depth",
        "nlp_inference_queue_wait_seconds",
        "nlp_inference_batch_size",
        "nlp_inference_rejections_total",
    ):
        assert family in metrics, f"{family} is not exposed on /metrics"


def test_rejections_are_counted_by_reason(client, monkeypatch) -> None:
    import nlp.api.v1.rest.guard as guard_module
    from nlp.core.batching import InferenceQueueFull
    from nlp.core.metrics import NLP_INFERENCE_REJECTIONS_TOTAL

    async def boom(*args, **kwargs):  # noqa: ANN002, ANN003
        raise InferenceQueueFull("full")

    monkeypatch.setattr(guard_module, "_acquire_guard", _fake_acquire(BatchingGuard()))
    monkeypatch.setattr(guard_module, "_submit_pii", boom)
    before = NLP_INFERENCE_REJECTIONS_TOTAL.labels(
        route="guard_pii", reason="queue_full"
    )._value.get()

    body = {"text": "hello", "model_name": MODEL, "labels": ["email"], "tenant_id": TENANT}
    client.post("/api/v1/guard/pii", json=body)

    after = NLP_INFERENCE_REJECTIONS_TOTAL.labels(
        route="guard_pii", reason="queue_full"
    )._value.get()
    assert after == before + 1
