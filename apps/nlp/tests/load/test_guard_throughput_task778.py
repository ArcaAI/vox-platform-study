"""TASK-778 — the 100-concurrent-session load driver. Repeatable, and REAL.

The platform target is >= 100 concurrent consultation sessions. This driver
measures it end to end: 100 concurrent HTTP requests through the real FastAPI
app, the real router, the real semaphore, the real coalescing batcher and — when
the weights are available locally — the real GLiNER2 forward pass.

Two modes, chosen by an env flag so the same file serves CI and a developer box:

* `NLP_LOAD_TEST_MODEL` unset (default, CI) — a calibrated stub whose per-pass
  cost is fixed by `NLP_LOAD_TEST_PASS_MS`. This measures the SERVING PIPELINE:
  queueing, coalescing, backpressure, event-loop headroom. It does not measure
  the model, and this file never pretends it does.
* `NLP_LOAD_TEST_MODEL=<AiModel.sourceUri>` — real weights, real forward passes.
  The id comes from the ENVIRONMENT of the measurement run, not from a literal:
  a benchmark that hardcoded a model id would be the same config violation the
  service itself is forbidden.

Marked `load` and deselected from the normal suite (`-m "not load"`), because a
throughput measurement on a shared CI runner measures the runner.

    # pipeline only, ~seconds
    pytest tests/load -m load -s
    # real weights
    NLP_LOAD_TEST_MODEL=<id> NLP_LOAD_TEST_CONCURRENCY=100 pytest tests/load -m load -s
"""

from __future__ import annotations

import asyncio
import os
import statistics
import time
from contextlib import asynccontextmanager

import httpx
import pytest

pytestmark = pytest.mark.load

TENANT = "11111111-1111-1111-1111-111111111111"

# A consultation-shaped utterance carrying the identifiers the PII plane exists
# to find. Synthetic — no real PHI ever enters a benchmark corpus.
SAMPLE = (
    "Patient Jane Roe, DOB 1974-03-02, called from 555-0100 about her results; "
    "please email jane.roe@example.org and update her chart at 41 Elm Street."
)
LABELS = ["person", "email", "phone_number", "address", "date_of_birth"]


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


CONCURRENCY = _env_int("NLP_LOAD_TEST_CONCURRENCY", 100)
ROUNDS = _env_int("NLP_LOAD_TEST_ROUNDS", 3)
PASS_MS = _env_int("NLP_LOAD_TEST_PASS_MS", 40)
# Batching geometry under test. Overridable so the tuning in the ticket README
# is REPRODUCIBLE — the recorded numbers name the geometry that produced them.
BATCH = _env_int("NLP_LOAD_TEST_BATCH", 16)
LINGER_MS = _env_int("NLP_LOAD_TEST_LINGER_MS", 8)
INFLIGHT = _env_int("NLP_LOAD_TEST_INFLIGHT", 2)
REAL_MODEL = os.environ.get("NLP_LOAD_TEST_MODEL", "").strip()

# TASK-782 — device placement and the two service classes.
#
# `NLP_LOAD_TEST_DEVICE` is where the tensors execute ("cpu" | "mps" | "cuda" |
# "auto"). It goes through the same `nlp.core.device` resolution the service
# uses, so a benchmark cannot accidentally measure a placement the service
# could not actually adopt.
DEVICE = os.environ.get("NLP_LOAD_TEST_DEVICE", "cpu").strip() or "cpu"
INTERACTIVE_BATCH = _env_int("NLP_LOAD_TEST_INTERACTIVE_BATCH", 4)
INTERACTIVE_LINGER_MS = _env_int("NLP_LOAD_TEST_INTERACTIVE_LINGER_MS", 2)
# The inline gate is measured WHILE the bulk lane saturates the model — a gate
# latency measured on an idle service is not a latency the platform ever sees.
INTERACTIVE_COUNT = _env_int("NLP_LOAD_TEST_INTERACTIVE_COUNT", 20)
INTERACTIVE_GAP_MS = _env_int("NLP_LOAD_TEST_INTERACTIVE_GAP_MS", 50)


class CalibratedStub:
    """A model whose forward pass costs a FIXED time regardless of batch size.

    That is the property real encoder batching approximates and the reason
    batching works at all: the per-pass overhead is paid once. Using a constant
    here makes the pipeline's coalescing behaviour measurable without pretending
    to have measured the model.
    """

    def __init__(self, pass_seconds: float) -> None:
        self.pass_seconds = pass_seconds
        self.passes = 0
        self.items = 0

    async def batch_extract_entities(self, texts, labels, threshold, batch_size=8):  # noqa: ANN001
        self.passes += 1
        self.items += len(texts)
        # Blocking sleep on a worker thread — a real forward pass holds the GIL
        # in C, so `to_thread` is the honest analogue, not `asyncio.sleep`.
        await asyncio.to_thread(time.sleep, self.pass_seconds)
        return [[] for _ in texts]


def _percentiles(samples: list[float]) -> dict[str, float]:
    ordered = sorted(samples)
    quantiles = statistics.quantiles(ordered, n=100, method="inclusive")
    return {
        "p50": statistics.median(ordered),
        "p95": quantiles[94],
        "p99": quantiles[98],
        "min": ordered[0],
        "max": ordered[-1],
    }


def _report(
    title: str, latencies: list[float], wall: float, extra: str = "", codes: list[int] | None = None
) -> None:
    pct = _percentiles(latencies)
    print(f"\n===== {title} =====")
    print(f"requests            : {len(latencies)}")
    if codes is not None:
        histogram = {code: codes.count(code) for code in sorted(set(codes))}
        served = histogram.get(200, 0)
        print(f"status codes        : {histogram}")
        print(f"served (200)        : {served}/{len(codes)}")
        print(f"goodput             : {served / wall:.1f} req/s")
    print(f"concurrency         : {CONCURRENCY}")
    print(f"wall clock          : {wall:.2f} s")
    print(f"throughput          : {len(latencies) / wall:.1f} req/s")
    print(
        f"latency p50 / p95 / p99 : "
        f"{pct['p50'] * 1000:.0f} / {pct['p95'] * 1000:.0f} / {pct['p99'] * 1000:.0f} ms"
    )
    print(f"latency min / max   : {pct['min'] * 1000:.0f} / {pct['max'] * 1000:.0f} ms")
    if extra:
        print(extra)


async def _one(client, body: dict, sink: list[tuple[float, int]]) -> None:
    started = time.perf_counter()
    response = await client.post("/api/v1/guard/pii", json=body)
    sink.append((time.perf_counter() - started, response.status_code))


async def _drive(app, body: dict, n: int) -> tuple[list[float], list[int], float]:
    """Fire `n` requests concurrently at the real ASGI app; return latencies."""
    transport = httpx.ASGITransport(app=app)
    latencies: list[float] = []
    codes: list[int] = []

    async with httpx.AsyncClient(
        transport=transport, base_url="http://load", timeout=120.0
    ) as client:

        async def one() -> None:
            started = time.perf_counter()
            response = await client.post("/api/v1/guard/pii", json=body)
            latencies.append(time.perf_counter() - started)
            codes.append(response.status_code)

        # Warm one request first so model load / first-touch costs are not
        # charged to the measured window.
        await one()
        latencies.clear()
        codes.clear()

        started = time.perf_counter()
        await asyncio.gather(*(one() for _ in range(n)))
        wall = time.perf_counter() - started

    return latencies, codes, wall


def _build_app(monkeypatch, service) -> object:
    import nlp.api.v1.rest.guard as guard_module
    from nlp.app import get_app

    if service is not None:

        @asynccontextmanager
        async def _acquire(model_name, model_path=None):
            yield service

        monkeypatch.setattr(guard_module, "_acquire_guard", _acquire)
    return get_app()


@pytest.mark.asyncio
async def test_pipeline_throughput_at_target_concurrency(monkeypatch) -> None:
    """Serving-pipeline throughput at the target concurrency, with a calibrated model."""
    from nlp.core.config import settings as nlp_settings
    from nlp.services import guard_dispatch

    monkeypatch.setattr(
        nlp_settings.service, "service_token", type(nlp_settings.service.service_token)("")
    )
    monkeypatch.setattr(
        nlp_settings.service, "internal_access_token", type(nlp_settings.service.service_token)("")
    )
    # The bound must admit the target concurrency; 4 (the bootstrap floor) is a
    # single-node dev value, not the serving value.
    monkeypatch.setattr(nlp_settings.service, "inference_max_concurrent", CONCURRENCY)
    monkeypatch.setattr(nlp_settings.service, "inference_batch_max_size", BATCH)
    monkeypatch.setattr(nlp_settings.service, "inference_batch_linger_ms", LINGER_MS)
    monkeypatch.setattr(nlp_settings.service, "inference_max_inflight_batches", INFLIGHT)
    from nlp.core.concurrency import reset_inference_semaphore

    reset_inference_semaphore()
    await guard_dispatch.reset_guard_batchers()

    stub = CalibratedStub(PASS_MS / 1000.0)
    app = _build_app(monkeypatch, stub)
    body = {
        "text": SAMPLE,
        "model_name": "loadtest://calibrated-stub",
        "labels": LABELS,
        "threshold": 0.5,
        "tenant_id": TENANT,
    }

    all_latencies: list[float] = []
    total_wall = 0.0
    for _ in range(ROUNDS):
        latencies, codes, wall = await _drive(app, body, CONCURRENCY)
        assert set(codes) == {200}, f"non-200 responses: {sorted(set(codes))}"
        all_latencies += latencies
        total_wall += wall

    coalescing = stub.items / max(stub.passes, 1)
    _report(
        f"PIPELINE — calibrated stub, {PASS_MS}ms/pass",
        all_latencies,
        total_wall,
        extra=(
            f"forward passes      : {stub.passes} for {stub.items} items\n"
            f"mean batch size     : {coalescing:.1f}\n"
            f"speedup vs 1-per-pass: {coalescing:.1f}x fewer passes"
        ),
    )

    await guard_dispatch.reset_guard_batchers()
    assert coalescing > 1.0, "requests did not coalesce at target concurrency"


@pytest.mark.skipif(not REAL_MODEL, reason="set NLP_LOAD_TEST_MODEL to measure real weights")
@pytest.mark.asyncio
async def test_real_model_throughput_at_target_concurrency(monkeypatch) -> None:
    """The same drive, against real weights resolved from the environment."""
    from nlp.core.concurrency import reset_inference_semaphore
    from nlp.core.config import settings as nlp_settings
    from nlp.services import guard_dispatch

    secret = type(nlp_settings.service.service_token)
    monkeypatch.setattr(nlp_settings.service, "service_token", secret(""))
    monkeypatch.setattr(nlp_settings.service, "internal_access_token", secret(""))
    monkeypatch.setattr(nlp_settings.service, "inference_max_concurrent", CONCURRENCY)
    monkeypatch.setattr(nlp_settings.service, "inference_batch_max_size", BATCH)
    monkeypatch.setattr(nlp_settings.service, "inference_batch_linger_ms", LINGER_MS)
    monkeypatch.setattr(nlp_settings.service, "inference_max_inflight_batches", INFLIGHT)
    # TASK-782: placement is part of the geometry under test, resolved exactly
    # as the service resolves it.
    monkeypatch.setattr(nlp_settings.service, "inference_device", DEVICE)
    reset_inference_semaphore()
    await guard_dispatch.reset_guard_batchers()

    app = _build_app(monkeypatch, None)  # real cache, real weights
    body = {
        "text": SAMPLE,
        "model_name": REAL_MODEL,
        "labels": LABELS,
        "threshold": 0.5,
        "tenant_id": TENANT,
    }

    latencies, codes, wall = await _drive(app, body, CONCURRENCY)
    # NOT `== {200}`. Shedding with 503 at the declared ceilings IS the
    # contract under overload (§3.1), and a driver that asserts all-200 cannot
    # MEASURE the failure mode it exists to find — it just goes red and reports
    # no numbers. So: assert only that every response is a DECLARED outcome,
    # and report the histogram, throughput AND goodput. A geometry that sheds
    # is a real result about that geometry, not a broken test.
    undeclared = sorted(set(codes) - {200, 503})
    assert not undeclared, f"undeclared response codes: {undeclared}"
    _report(
        f"REAL WEIGHTS — {REAL_MODEL} "
        f"(device={DEVICE}, batch={BATCH}, linger={LINGER_MS}ms, inflight={INFLIGHT})",
        latencies,
        wall,
        codes=codes,
    )
    await guard_dispatch.reset_guard_batchers()


# ── TASK-782 — the two service classes, measured together ────────────────


def _apply_geometry(monkeypatch) -> None:
    """Pin the geometry under test onto the real settings the service reads."""
    from nlp.core.config import settings as nlp_settings

    secret = type(nlp_settings.service.service_token)
    monkeypatch.setattr(nlp_settings.service, "service_token", secret(""))
    monkeypatch.setattr(nlp_settings.service, "internal_access_token", secret(""))
    monkeypatch.setattr(
        nlp_settings.service, "inference_max_concurrent", CONCURRENCY + INTERACTIVE_COUNT
    )
    monkeypatch.setattr(nlp_settings.service, "inference_batch_max_size", BATCH)
    monkeypatch.setattr(nlp_settings.service, "inference_batch_linger_ms", LINGER_MS)
    monkeypatch.setattr(nlp_settings.service, "inference_max_inflight_batches", INFLIGHT)
    monkeypatch.setattr(
        nlp_settings.service, "inference_interactive_batch_max_size", INTERACTIVE_BATCH
    )
    monkeypatch.setattr(
        nlp_settings.service, "inference_interactive_batch_linger_ms", INTERACTIVE_LINGER_MS
    )
    monkeypatch.setattr(nlp_settings.service, "inference_device", DEVICE)


@pytest.mark.skipif(not REAL_MODEL, reason="set NLP_LOAD_TEST_MODEL to measure real weights")
@pytest.mark.asyncio
async def test_inline_gate_latency_under_bulk_load(monkeypatch) -> None:
    """The question TASK-782 exists to answer, measured the only honest way.

    A synchronous inline gate does not run on an idle service — it runs while
    the asynchronous per-utterance redaction pass is saturating the same
    weights. So the bulk lane is driven at the target concurrency and the
    interactive lane is paced through it, and BOTH classes are reported
    separately with their own status histogram.
    """
    from nlp.core.concurrency import reset_inference_semaphore
    from nlp.services import guard_dispatch

    _apply_geometry(monkeypatch)
    reset_inference_semaphore()
    await guard_dispatch.reset_guard_batchers()

    app = _build_app(monkeypatch, None)  # real cache, real weights, real placement

    def body(lane: str) -> dict:
        return {
            "text": SAMPLE,
            "model_name": REAL_MODEL,
            "labels": LABELS,
            "threshold": 0.5,
            "tenant_id": TENANT,
            "latency_class": lane,
        }

    transport = httpx.ASGITransport(app=app)
    bulk: list[tuple[float, int]] = []
    interactive: list[tuple[float, int]] = []

    async with httpx.AsyncClient(
        transport=transport, base_url="http://load", timeout=180.0
    ) as client:
        # Warm: the weight load and first-touch cost belong to neither class.
        await _one(client, body("bulk"), [])

        async def pace_interactive() -> None:
            tasks = []
            for _ in range(INTERACTIVE_COUNT):
                tasks.append(asyncio.create_task(_one(client, body("interactive"), interactive)))
                await asyncio.sleep(INTERACTIVE_GAP_MS / 1000.0)
            await asyncio.gather(*tasks)

        started = time.perf_counter()
        await asyncio.gather(
            *(_one(client, body("bulk"), bulk) for _ in range(CONCURRENCY)),
            pace_interactive(),
        )
        wall = time.perf_counter() - started

    header = (
        f"device={DEVICE} bulk(batch={BATCH}, linger={LINGER_MS}ms) "
        f"interactive(batch={INTERACTIVE_BATCH}, linger={INTERACTIVE_LINGER_MS}ms) "
        f"inflight={INFLIGHT}"
    )
    for label, samples in (("BULK", bulk), ("INTERACTIVE", interactive)):
        latencies = [lat for lat, _ in samples]
        codes = [code for _, code in samples]
        undeclared = sorted(set(codes) - {200, 503})
        assert not undeclared, f"{label}: undeclared response codes: {undeclared}"
        _report(f"{label} — {REAL_MODEL} — {header}", latencies, wall, codes=codes)

    await guard_dispatch.reset_guard_batchers()
