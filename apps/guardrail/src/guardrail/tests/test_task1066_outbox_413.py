"""A 413 from the gateway halves the batch; a single oversize row is dropped and counted."""

from __future__ import annotations

import json
from typing import Any

import fakeredis.aioredis
import httpx
import pytest

from guardrail.services.evaluation_outbox import OUTBOX_STREAM, EvaluationDrainer, EvaluationOutbox


def _record(n: int, pad: str = "") -> dict[str, Any]:
    return {
        "evaluationId": f"ev-{n}",
        "tenantId": "tenant-a",
        "requestId": "r",
        "checks": [],
        "pad": pad,
    }


class _Gateway:
    """413 for any batch over `max_rows` rows, or any batch holding a row flagged oversize."""

    def __init__(self, max_rows: int, oversize_ids: set[str] | None = None) -> None:
        self.max_rows = max_rows
        self.oversize_ids = oversize_ids or set()
        self.sizes: list[int] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        rows = json.loads(request.content)["evaluations"]
        self.sizes.append(len(rows))
        if len(rows) > self.max_rows or any(r["evaluationId"] in self.oversize_ids for r in rows):
            return httpx.Response(413, json={"code": "REQUEST.PAYLOAD_TOO_LARGE"})
        return httpx.Response(200, json={"accepted": len(rows), "duplicates": 0})


def _drainer(redis: Any, gw: _Gateway) -> EvaluationDrainer:
    return EvaluationDrainer(
        redis,
        httpx.AsyncClient(transport=httpx.MockTransport(gw.handler)),
        gateway_url="http://gw/api/v1",
        token="t",
        consumer="c",
        batch_max=100,
    )


@pytest.mark.asyncio
async def test_a_413_halves_the_batch_until_it_fits() -> None:
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    outbox = EvaluationOutbox(redis, maxlen=1000)
    for n in range(100):
        await outbox.append(_record(n))
    gw = _Gateway(max_rows=30)
    assert await _drainer(redis, gw).drain_once() == 100
    assert gw.sizes[:3] == [100, 50, 25]
    assert await redis.xlen(OUTBOX_STREAM) == 0


@pytest.mark.asyncio
async def test_a_single_oversize_row_is_dropped_and_the_rest_delivered() -> None:
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    outbox = EvaluationOutbox(redis, maxlen=1000)
    for n in range(4):
        await outbox.append(_record(n))
    gw = _Gateway(max_rows=100, oversize_ids={"ev-2"})
    assert await _drainer(redis, gw).drain_once() == 3
    assert await redis.xlen(OUTBOX_STREAM) == 0  # nothing retried forever
    assert 1 in gw.sizes
