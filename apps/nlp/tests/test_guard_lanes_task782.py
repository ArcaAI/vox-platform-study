"""two service classes over one weight slot.

shipped ONE queue geometry for both the asynchronous per-utterance
redaction pass and a synchronous inline gate, and measured p95 ~1.7 s at 100
concurrent. That is the right number for the first job and the wrong one for the
second. These tests pin the split: separate queues with separate geometry AND
separate declared ceilings, a shared per-model in-flight bound so the split
cannot double the passes hitting one tensor graph, and priority so the gate can
overtake a merely-queued bulk pass.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest

from nlp.core.config import settings
from nlp.services import guard_dispatch
from nlp.services.guard_dispatch import (
    LANE_BULK,
    LANE_INTERACTIVE,
    batch_size_for,
    get_batcher,
    normalize_lane,
)

MODEL = "loadtest://lanes"
TENANT = "11111111-1111-1111-1111-111111111111"


# ── lane normalisation ───────────────────────────────────────────────────


def test_an_absent_class_is_the_bulk_lane() -> None:
    """The caller named no class; it must keep its exact behaviour."""
    assert normalize_lane(None) == LANE_BULK
    assert normalize_lane("") == LANE_BULK


def test_an_unrecognised_class_gets_the_SLOWER_lane() -> None:
    """A typo must never buy priority on a shared resource."""
    assert normalize_lane("urgent") == LANE_BULK
    assert normalize_lane("INTERACTIVE") == LANE_INTERACTIVE


# ── geometry ─────────────────────────────────────────────────────────────


def test_the_two_lanes_do_not_share_a_geometry(monkeypatch) -> None:
    monkeypatch.setattr(settings.service, "inference_batch_max_size", 16)
    monkeypatch.setattr(settings.service, "inference_interactive_batch_max_size", 4)
    assert batch_size_for(LANE_BULK) == 16
    assert batch_size_for(LANE_INTERACTIVE) == 4


def test_the_interactive_ceiling_is_its_declared_slo(monkeypatch) -> None:
    """Past the ceiling the verdict is too late to gate anything — shed instead."""
    interactive = guard_dispatch._batching_config(LANE_INTERACTIVE)
    bulk = guard_dispatch._batching_config(LANE_BULK)
    assert interactive["max_wait_s"] < bulk["max_wait_s"]
    assert interactive["linger_ms"] <= bulk["linger_ms"]
    assert interactive["max_batch_size"] <= bulk["max_batch_size"]


@pytest.mark.asyncio
async def test_each_lane_gets_its_own_batcher_over_one_slot() -> None:
    await guard_dispatch.reset_guard_batchers()

    async def run_batch(_group, items):  # noqa: ANN001
        return [None] * len(items)

    a = await get_batcher("slot", "pii", run_batch, LANE_INTERACTIVE)
    b = await get_batcher("slot", "pii", run_batch, LANE_BULK)
    assert a is not b
    # The lane rides in the NAME, which is the label on every batcher metric —
    # so the two classes are separately observable without a metric change.
    assert a.name.endswith(LANE_INTERACTIVE)
    assert b.name.endswith(LANE_BULK)
    await guard_dispatch.reset_guard_batchers()


@pytest.mark.asyncio
async def test_both_lanes_share_ONE_in_flight_bound_per_weight_slot() -> None:
    """Per-batcher bounds would double the passes hitting one tensor graph."""
    await guard_dispatch.reset_guard_batchers()

    async def run_batch(_group, items):  # noqa: ANN001
        return [None] * len(items)

    a = await get_batcher("slot-x", "pii", run_batch, LANE_INTERACTIVE)
    b = await get_batcher("slot-x", "pii", run_batch, LANE_BULK)
    other = await get_batcher("slot-y", "pii", run_batch, LANE_BULK)

    assert a._inflight is b._inflight
    assert a._inflight is not other._inflight  # a different model, a different bound
    await guard_dispatch.reset_guard_batchers()


@pytest.mark.asyncio
async def test_the_interactive_lane_overtakes_a_queued_bulk_pass(monkeypatch) -> None:
    """The reason separate queues alone were not enough: they share the model."""
    # One permit, so every pass after the first must queue for it — which is the
    # only state in which priority can be observed at all.
    monkeypatch.setattr(settings.service, "inference_max_inflight_batches", 1)
    await guard_dispatch.reset_guard_batchers()
    order: list[str] = []
    gate = asyncio.Event()

    async def run_batch(group, items):  # noqa: ANN001
        order.append(group)
        await gate.wait()
        return [None] * len(items)

    bulk = await get_batcher("slot-p", "pii", run_batch, LANE_BULK)
    interactive = await get_batcher("slot-p", "pii", run_batch, LANE_INTERACTIVE)
    assert bulk._inflight.limit == 1

    first = asyncio.create_task(bulk.submit("bulk-1", "a"))
    await asyncio.sleep(0.05)
    queued_bulk = [asyncio.create_task(bulk.submit(f"bulk-{i}", "b")) for i in (2, 3)]
    await asyncio.sleep(0.05)
    express = asyncio.create_task(interactive.submit("gate-1", "c"))
    await asyncio.sleep(0.05)

    gate.set()
    await asyncio.gather(first, express, *queued_bulk)

    assert order[0] == "bulk-1"
    assert "gate-1" in order
    assert order.index("gate-1") < order.index("bulk-2"), order
    await guard_dispatch.reset_guard_batchers()


# ── end to end through the route ─────────────────────────────────────────


class _Runtime:
    """Records the lane-derived batch_size each pass was driven with."""

    def __init__(self) -> None:
        self.batch_sizes: list[int] = []

    async def batch_extract_entities(self, texts, labels, threshold, batch_size=8):  # noqa: ANN001
        self.batch_sizes.append(batch_size)
        return [[] for _ in texts]


@pytest.fixture
def lane_client(client, monkeypatch):
    """The shared hermetic client (conftest) with a recording runtime behind it.

    Deliberately NOT a second `TestClient(get_app())`: the Prometheus
    instrumentator registers `fastapi_inprogress` on the global registry, so a
    second app in one process raises `DuplicateTimeseries`.
    """
    import nlp.api.v1.rest.guard as guard_module

    runtime = _Runtime()

    @asynccontextmanager
    async def _acquire(model_name, model_path=None):  # noqa: ANN001
        yield runtime

    monkeypatch.setattr(guard_module, "_acquire_guard", _acquire)
    monkeypatch.setattr(settings.service, "inference_batch_max_size", 16)
    monkeypatch.setattr(settings.service, "inference_interactive_batch_max_size", 3)
    return client, runtime


def _body(**extra):
    return {
        "text": "Patient Jane Roe called from 555-0100.",
        "model_name": MODEL,
        "labels": ["person", "phone_number"],
        "tenant_id": TENANT,
        **extra,
    }


def test_the_route_drives_the_lane_s_batch_size(lane_client) -> None:
    test_client, runtime = lane_client
    assert test_client.post("/api/v1/guard/pii", json=_body()).status_code == 200
    assert runtime.batch_sizes[-1] == 16, "an unclassed request must stay bulk"

    assert (
        test_client.post("/api/v1/guard/pii", json=_body(latency_class="interactive")).status_code
        == 200
    )
    assert runtime.batch_sizes[-1] == 3


def test_an_undeclared_latency_class_is_rejected_by_the_schema(lane_client) -> None:
    """`latency_class` is a declared enum, not free text the caller invents."""
    test_client, _ = lane_client
    response = test_client.post("/api/v1/guard/pii", json=_body(latency_class="urgent"))
    assert response.status_code == 422
