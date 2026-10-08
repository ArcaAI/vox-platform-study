"""TASK-1050 W2a2 — an evaluation record for EVERY screen, at least once (README §9.8.2).

* the record shape is pinned to `tests/contracts/guardrail-evaluation.fixture.json`;
* the record is appended to the Redis-stream outbox BEFORE the route answers;
* the drainer posts per-tenant batches of ≤ 100, acknowledges only on success,
  redrives on failure, and a gateway outage never changes a verdict;
* `guardrail:config:invalidate` drops the matching tenant-config cache entries;
* F8: PII spans are never computed on instruction regions, nor for a LOCAL provider.

Fakes only: fakeredis (a declared dev dependency), an httpx MockTransport, stub analyzers.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import fakeredis.aioredis
import httpx
import pytest

from guardrail.core.availability import GuardrailAvailability
from guardrail.services.evaluation_outbox import (
    GUARDRAIL_EVALUATIONS_PATH,
    OUTBOX_STREAM,
    EvaluationDrainer,
    EvaluationOutbox,
    build_evaluation_record,
    uuid7,
)
from guardrail.services.notices import GuardrailCorrelation, build_notices
from guardrail.services.screening import Screener

_REPO = Path(__file__).parents[5]
FIXTURE = json.loads(
    (_REPO / "tests" / "contracts" / "guardrail-evaluation.fixture.json").read_text()
)
VOCAB = json.loads(
    (_REPO / "tests" / "contracts" / "guardrail-vocabulary.fixture.json").read_text()
)
TENANT = "50000000-0000-0000-0000-000000000000"


class _Analyzer:
    def __init__(
        self,
        unsafe_word: str | None = None,
        *,
        fail: bool = False,
        only: tuple[str, ...] | None = None,
    ) -> None:
        self.unsafe_word = unsafe_word
        self.fail = fail
        self.only = only

    async def classify_tasks(self, task_names: Any, text: str) -> dict[str, Any]:
        if self.fail:
            from guardrail.core.errors import REASON_ENGINE_ERROR, GuardrailUndeterminedError

            raise GuardrailUndeterminedError(REASON_ENGINE_ERROR, "down")
        bad = bool(self.unsafe_word and self.unsafe_word in text)
        return {
            task: ["unsafe" if bad and (self.only is None or task in self.only) else "benign"]
            for task in task_names
        }

    async def extract_pii_entities(self, text: str) -> list[Any]:
        return []

    def model_for(self, check: str) -> str:
        return "gliguard-base"


def _keys_union(records: list[dict[str, Any]]) -> tuple[set[str], set[str]]:
    every = set.intersection(*(set(r) for r in records))
    some = set.union(*(set(r) for r in records))
    return every, some


# ── the record shape ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_record_shape_matches_the_frozen_fixture() -> None:
    fixture_records = FIXTURE["batch"]["evaluations"]
    required, allowed = _keys_union(fixture_records)
    fixture_checks = [c for r in fixture_records for c in r["checks"]]
    check_required, check_allowed = _keys_union(fixture_checks)

    screener = Screener(
        analyzer=_Analyzer("BAD", only=("prompt_safety",)),
        tenant_id=TENANT,
        availability=GuardrailAvailability.from_tiers(
            system_blob={"checks": {"prompt_safety": {"enabled": True, "action": "warn"}}},
            tenant_blob=None,
        ),
        policy_version="pv-1",
    )
    decision = await screener.screen_inbound_regions(
        [("system", "rules", "instruction"), ("transcript", "BAD words", "instruction")],
        items={"transcript": [("item-1", 2)]},
    )
    correlation = GuardrailCorrelation(
        request_id="req-1", consultation_id="c-1", run_id="run-1", node_id="n1"
    )
    notices = build_notices(
        decision,
        tenant_id=TENANT,
        correlation=correlation,
        policy_version="pv-1",
        occurred_at="2026-10-07T09:15:00.000Z",
    )
    record = build_evaluation_record(
        decision,
        tenant_id=TENANT,
        correlation=correlation,
        caller="text.generate",
        notices=notices,
        occurred_at="2026-10-07T09:15:00.000Z",
    )

    assert required <= set(record)
    assert set(record) <= allowed | {"notices"}
    assert record["decision"] == "warn"
    assert record["direction"] == "inbound"
    assert record["caller"] in VOCAB["callers"]
    assert record["noticeIds"] == [n["noticeId"] for n in notices]
    assert record["notices"] == notices
    assert "withheldContent" not in record
    assert re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        record["evaluationId"],
    )
    for check in record["checks"]:
        assert check_required <= set(check)
        assert set(check) <= check_allowed
        assert check["verdict"] in VOCAB["checkVerdicts"]
        assert check["actionTaken"] in VOCAB["actionsTaken"]
        assert check["checkId"] in VOCAB["checkIds"]
    by_id = {c["checkId"]: c for c in record["checks"]}
    assert by_id["prompt_safety"]["items"] == [{"itemId": "item-1", "itemVersion": 2}]
    assert by_id["prompt_safety"]["category"] == "unsafe"
    # Every declared check of the direction is on the record, skipped ones included —
    # the inbound judges are OFF by default and appear as `skipped` with no model.
    assert by_id["injection_judge"] == {
        "checkId": "injection_judge",
        "verdict": "skipped",
        "actionTaken": "none",
        "model": None,
        "latencyMs": 0,
        "regionKeys": [],
        "items": [],
        # TASK-1050 follow-up H: a skipped check explains itself.
        "reason": "not_selected_for_tenant",
    }
    # The medical check is the medical route's own record, never invented here.
    assert "medical_validation" not in by_id


@pytest.mark.asyncio
async def test_a_clean_pass_still_produces_a_record_without_notices() -> None:
    decision = await Screener(analyzer=_Analyzer(), tenant_id=TENANT).screen_inbound("hello")
    record = build_evaluation_record(
        decision,
        tenant_id=TENANT,
        correlation=GuardrailCorrelation(request_id="req-2"),
        caller="playground",
        notices=[],
        occurred_at="t",
    )
    assert record["decision"] == "allow"
    assert record["noticeIds"] == []
    assert "notices" not in record
    assert "consultationId" not in record


@pytest.mark.asyncio
async def test_withheld_content_rides_only_an_outbound_block() -> None:
    blocked = await Screener(analyzer=_Analyzer("BAD"), tenant_id=TENANT).screen_outbound(
        "a BAD note", source_context="x", nonce="n"
    )
    record = build_evaluation_record(
        blocked,
        tenant_id=TENANT,
        correlation=GuardrailCorrelation(request_id="r"),
        caller="text.generate",
        notices=[],
        occurred_at="t",
        response_text="a BAD note",
    )
    assert record["decision"] == "block"
    assert record["withheldContent"] == "a BAD note"

    inbound = await Screener(analyzer=_Analyzer("BAD"), tenant_id=TENANT).screen_inbound(
        "a BAD prompt"
    )
    record = build_evaluation_record(
        inbound,
        tenant_id=TENANT,
        correlation=GuardrailCorrelation(request_id="r"),
        caller="text.generate",
        notices=[],
        occurred_at="t",
        response_text="a BAD prompt",
    )
    assert record["decision"] == "block"
    assert "withheldContent" not in record


def test_uuid7_is_time_ordered() -> None:
    first, second = uuid7(), uuid7()
    assert first[14] == "7"
    assert first[:13] <= second[:13]


def test_the_path_and_batch_size_are_the_frozen_ones() -> None:
    assert GUARDRAIL_EVALUATIONS_PATH == VOCAB["evaluation"]["path"]
    assert FIXTURE["batchMax"] == VOCAB["evaluation"]["batchMax"] == 100


# ── the outbox and the drainer ────────────────────────────────────────────────


def _record(tenant: str, n: int) -> dict[str, Any]:
    return {"evaluationId": f"ev-{tenant}-{n}", "tenantId": tenant, "requestId": "r", "checks": []}


class _Gateway:
    def __init__(self, statuses: list[int] | None = None) -> None:
        self.statuses = list(statuses or [])
        self.posts: list[dict[str, Any]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.posts.append({"url": str(request.url), "headers": dict(request.headers), "body": body})
        status = self.statuses.pop(0) if self.statuses else 200
        return httpx.Response(status, json={"accepted": len(body["evaluations"]), "duplicates": 0})


def _drainer(redis: Any, gateway: _Gateway, **kw: Any) -> EvaluationDrainer:
    client = httpx.AsyncClient(transport=httpx.MockTransport(gateway.handler))
    return EvaluationDrainer(
        redis,
        client,
        gateway_url="http://gw:8868/api/v1",
        token="svc-token",
        consumer="test-consumer",
        **kw,
    )


@pytest.mark.asyncio
async def test_drainer_posts_per_tenant_batches_of_at_most_100_and_acks() -> None:
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    outbox = EvaluationOutbox(redis, maxlen=10_000)
    for n in range(150):
        assert await outbox.append(_record("tenant-a", n))
    await outbox.append(_record("tenant-b", 0))
    gateway = _Gateway()
    drainer = _drainer(redis, gateway, batch_max=100)

    drained = 0
    for _ in range(3):
        drained += await drainer.drain_once()
    assert drained == 151
    assert all(len(p["body"]["evaluations"]) <= 100 for p in gateway.posts)
    assert sum(len(p["body"]["evaluations"]) for p in gateway.posts) == 151
    for post in gateway.posts:
        assert (
            post["url"] == f"http://gw:8868/api/v1/{GUARDRAIL_EVALUATIONS_PATH}?service=guardrail"
        )
        assert post["headers"]["x-service-token"] == "svc-token"
        tenants = {r["tenantId"] for r in post["body"]["evaluations"]}
        assert tenants == {post["headers"]["x-tenant-id"]}
    assert await redis.xlen(OUTBOX_STREAM) == 0


@pytest.mark.asyncio
async def test_a_failed_post_is_redriven_never_dropped() -> None:
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    outbox = EvaluationOutbox(redis, maxlen=1000)
    await outbox.append(_record("tenant-a", 1))
    gateway = _Gateway(statuses=[503])
    drainer = _drainer(redis, gateway, redrive_idle_ms=0)

    assert await drainer.drain_once() == 0  # gateway down: nothing acknowledged
    assert await redis.xlen(OUTBOX_STREAM) == 1
    assert await drainer.drain_once() == 1  # redriven from the pending list
    assert [p["body"]["evaluations"][0]["evaluationId"] for p in gateway.posts] == [
        "ev-tenant-a-1"
    ] * 2
    assert await redis.xlen(OUTBOX_STREAM) == 0


@pytest.mark.asyncio
async def test_a_transport_error_is_redriven_too() -> None:
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    await EvaluationOutbox(redis, maxlen=1000).append(_record("tenant-a", 1))
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("gateway down")
        return httpx.Response(200, json={"accepted": 1, "duplicates": 0})

    drainer = EvaluationDrainer(
        redis,
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        gateway_url="http://gw/api/v1",
        token="t",
        consumer="c",
        redrive_idle_ms=0,
    )
    assert await drainer.drain_once() == 0
    assert await drainer.drain_once() == 1


@pytest.mark.asyncio
async def test_a_rejected_batch_is_not_redriven_forever() -> None:
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    await EvaluationOutbox(redis, maxlen=1000).append(_record("tenant-a", 1))
    gateway = _Gateway(statuses=[400])
    drainer = _drainer(redis, gateway, redrive_idle_ms=0)
    assert await drainer.drain_once() == 0
    assert await redis.xlen(OUTBOX_STREAM) == 0
    assert await drainer.drain_once() == 0
    assert len(gateway.posts) == 1


@pytest.mark.asyncio
async def test_the_stream_is_bounded() -> None:
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    outbox = EvaluationOutbox(redis, maxlen=10, approximate=False)
    for n in range(25):
        await outbox.append(_record("t", n))
    assert await redis.xlen(OUTBOX_STREAM) == 10


@pytest.mark.asyncio
async def test_an_outbox_outage_never_raises() -> None:
    class _Broken:
        async def xadd(self, *a: Any, **k: Any) -> Any:
            raise ConnectionError("redis down")

    assert await EvaluationOutbox(_Broken(), maxlen=10).append(_record("t", 1)) is False


# ── the route: write before answer, new fields, correlation ───────────────────


class _RecordingOutbox:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.records: list[dict[str, Any]] = []

    async def append(self, record: dict[str, Any]) -> bool:
        self.events.append("append")
        self.records.append(record)
        return True


def _request(outbox: Any, headers: dict[str, str]) -> Any:
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(admission_gates={}, evaluation_outbox=outbox)),
        headers=headers,
    )


@pytest.mark.asyncio
async def test_inbound_route_writes_the_record_before_answering(monkeypatch: Any) -> None:
    import guardrail.api.endpoints.screen as screen_mod
    from guardrail.api.endpoints.screen import InboundScreenRequest, screen_inbound

    events: list[str] = []
    outbox = _RecordingOutbox(events)

    async def _build(app_state: Any, tenant_id: str, **_: Any) -> Screener:
        events.append("build")
        return Screener(
            analyzer=_Analyzer("BAD", only=("prompt_safety",)),
            tenant_id=tenant_id,
            availability=GuardrailAvailability.from_tiers(
                system_blob={"checks": {"prompt_safety": {"enabled": True, "action": "warn"}}},
                tenant_blob=None,
            ),
            policy_version="pv-9",
        )

    monkeypatch.setattr(screen_mod, "build_screener", _build)
    headers = {
        "X-Tenant-Id": TENANT,
        "X-Request-Id": "req-abc",
        "X-Hope-Consultation-Id": "c-1",
        "X-Hope-Run-Id": "run-1",
        "X-Hope-Run-Key": "rk-1",
        "X-Hope-Node-Id": "n1",
        "X-Hope-Item-Id": "i-1",
    }
    body = InboundScreenRequest(
        regions=[
            {
                "key": "transcript",
                "text": "BAD words",
                "trust": "instruction",
                "items": [{"itemId": "item-7", "itemVersion": 4}],
            }
        ],
        caller="harness.guardrail_check",
        agent_slug="soap-note-writer",
    )
    response = await screen_inbound(body, _request(outbox, headers))  # type: ignore[arg-type]
    events.append("answered")

    assert events == ["build", "append", "answered"]
    (record,) = outbox.records
    assert response.decision == "allow"  # legacy callers read a warn as allow
    assert response.guardrail_decision == "warn"
    assert response.evaluation_id == record["evaluationId"]
    assert [n["noticeId"] for n in response.notices] == record["noticeIds"]
    assert response.notices[0]["itemIds"] == ["item-7"]
    assert record["requestId"] == "req-abc"
    assert (
        record["consultationId"],
        record["runId"],
        record["runKey"],
        record["nodeId"],
        record["itemId"],
    ) == (
        "c-1",
        "run-1",
        "rk-1",
        "n1",
        "i-1",
    )
    assert record["caller"] == "harness.guardrail_check"
    assert record["agentSlug"] == "soap-note-writer"
    assert record["policyVersion"] == "pv-9"
    check = next(c for c in response.checks if c["name"] == "prompt_safety")
    assert check["actionTaken"] == "warn"


@pytest.mark.asyncio
async def test_an_authoring_screen_is_recorded_but_raises_no_client_notice(
    monkeypatch: Any,
) -> None:
    """The governed-prompt registry screens authored text with no client waiting on it:
    the evaluation is recorded under its own caller, the verdict is unchanged, and no
    notice is raised (a notice is a CLIENT message — nobody could ever see or resolve it)."""
    import guardrail.api.endpoints.screen as screen_mod
    from guardrail.api.endpoints.screen import InboundScreenRequest, screen_inbound

    outbox = _RecordingOutbox([])

    async def _build(app_state: Any, tenant_id: str, **_: Any) -> Screener:
        return Screener(
            analyzer=_Analyzer("BAD", only=("prompt_safety",)),
            tenant_id=tenant_id,
            availability=GuardrailAvailability.from_tiers(
                system_blob={"checks": {"prompt_safety": {"enabled": True, "action": "block"}}},
                tenant_blob=None,
            ),
            policy_version="pv-9",
        )

    monkeypatch.setattr(screen_mod, "build_screener", _build)
    body = InboundScreenRequest(
        regions=[{"key": "piece-1", "text": "BAD words"}],
        caller="governed_prompt",
    )
    response = await screen_inbound(body, _request(outbox, {"X-Tenant-Id": TENANT}))  # type: ignore[arg-type]

    (record,) = outbox.records
    assert response.decision == "block"
    assert record["caller"] == "governed_prompt"
    assert record["decision"] == "block"
    assert response.notices == []
    assert record["noticeIds"] == []


@pytest.mark.asyncio
async def test_outbound_route_withholds_the_response_on_a_block(monkeypatch: Any) -> None:
    import guardrail.api.endpoints.screen as screen_mod
    from guardrail.api.endpoints.screen import OutboundScreenRequest, screen_outbound

    outbox = _RecordingOutbox([])

    async def _build(app_state: Any, tenant_id: str, **_: Any) -> Screener:
        return Screener(analyzer=_Analyzer("BAD"), tenant_id=tenant_id, policy_version="pv-1")

    monkeypatch.setattr(screen_mod, "build_screener", _build)
    body = OutboundScreenRequest(
        response="a BAD note",
        source_context="src",
        nonce="n",
        response_items=[{"itemId": "out-1", "itemVersion": 1}],
    )
    response = await screen_outbound(body, _request(outbox, {"X-Tenant-Id": TENANT}))  # type: ignore[arg-type]
    (record,) = outbox.records
    assert response.decision == "block"
    assert record["decision"] == "block"
    assert record["withheldContent"] == "a BAD note"
    assert record["caller"] == "text.generate"  # the default when a caller sends none
    assert record["requestId"]  # minted when absent, never empty
    assert response.notices[0]["type"] == "guardrail.blocked"


@pytest.mark.asyncio
async def test_a_dead_outbox_never_changes_the_verdict(monkeypatch: Any) -> None:
    import guardrail.api.endpoints.screen as screen_mod
    from guardrail.api.endpoints.screen import InboundScreenRequest, screen_inbound

    class _Dead:
        async def append(self, record: dict[str, Any]) -> bool:
            raise RuntimeError("redis down")

    async def _build(app_state: Any, tenant_id: str, **_: Any) -> Screener:
        return Screener(analyzer=_Analyzer(), tenant_id=tenant_id)

    monkeypatch.setattr(screen_mod, "build_screener", _build)
    response = await screen_inbound(InboundScreenRequest(text="hello"), _request(_Dead(), {"X-Tenant-Id": TENANT}))  # type: ignore[arg-type]
    assert response.decision == "allow"
    assert response.evaluation_id


# ── F8: PII spans ─────────────────────────────────────────────────────────────


class _SpanClient:
    model_id = "pii-model"

    def __init__(self) -> None:
        self.texts: list[str] = []

    async def extract_pii_entities(self, text: str) -> list[Any]:
        self.texts.append(text)
        return []


@pytest.mark.asyncio
async def test_pii_spans_skip_instruction_regions_and_local_providers(monkeypatch: Any) -> None:
    import guardrail.api.endpoints.screen as screen_mod
    from guardrail.api.endpoints.screen import InboundScreenRequest, screen_inbound

    spans = _SpanClient()

    async def _build(app_state: Any, tenant_id: str, **_: Any) -> Screener:
        return Screener(analyzer=_Analyzer(), tenant_id=tenant_id)

    async def _span_client(app_state: Any, tenant_id: str) -> _SpanClient:
        return spans

    monkeypatch.setattr(screen_mod, "build_screener", _build)
    monkeypatch.setattr(screen_mod, "build_pii_span_client", _span_client)
    regions = [
        {"key": "system", "text": "instruction text", "trust": "instruction"},
        {"key": "transcript", "text": "patient data", "trust": "data"},
    ]
    cloud = await screen_inbound(  # type: ignore[arg-type]
        InboundScreenRequest(regions=regions, include_pii_spans=True, locality="cloud"),
        _request(_RecordingOutbox([]), {"X-Tenant-Id": TENANT}),
    )
    assert spans.texts == ["patient data"]
    assert cloud.pii_spans == []

    spans.texts.clear()
    local = await screen_inbound(  # type: ignore[arg-type]
        InboundScreenRequest(regions=regions, include_pii_spans=True, locality="local"),
        _request(_RecordingOutbox([]), {"X-Tenant-Id": TENANT}),
    )
    assert spans.texts == []
    assert local.pii_spans == []


# ── invalidation ──────────────────────────────────────────────────────────────


def test_invalidation_payload_parsing() -> None:
    from guardrail.core.tenant_config import parse_guardrail_config_invalidation

    assert parse_guardrail_config_invalidation("") == (None, None)
    assert parse_guardrail_config_invalidation("{}") == (None, None)
    assert parse_guardrail_config_invalidation("not json") == (None, None)
    assert parse_guardrail_config_invalidation(json.dumps({"tenantId": "t-1"})) == ("t-1", None)
    assert parse_guardrail_config_invalidation(
        json.dumps({"tenantId": "t-1", "taskKeys": ["guardrail.safety", 3, ""]})
    ) == ("t-1", ("guardrail.safety",))
    assert parse_guardrail_config_invalidation(
        json.dumps({"taskKeys": ["guardrail.validate"]})
    ) == (
        None,
        ("guardrail.validate",),
    )


@pytest.mark.asyncio
async def test_a_published_invalidation_drops_the_matching_cache_entries() -> None:
    from guardrail.core.tenant_config import (
        GUARDRAIL_CONFIG_INVALIDATION_CHANNEL,
        TenantConfigResolver,
        _CacheEntry,
        guardrail_config_invalidation_listener,
    )

    assert GUARDRAIL_CONFIG_INVALIDATION_CHANNEL == "guardrail:config:invalidate"
    resolver = TenantConfigResolver(session_factory=lambda: None, cache_ttl_s=60)  # type: ignore[arg-type,return-value]
    for key in (
        "guardrail.safety::t-1",
        "guardrail.validate::t-1",
        "guardrail.availability::t-1",
        "guardrail.safety::t-2",
    ):
        resolver._cache[key] = _CacheEntry(keys={"model": "m"}, expires_at=10**12)

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    task = asyncio.create_task(guardrail_config_invalidation_listener(redis, resolver))
    try:
        for _ in range(50):
            if (await redis.pubsub_numsub(GUARDRAIL_CONFIG_INVALIDATION_CHANNEL))[0][1]:
                break
            await asyncio.sleep(0.01)
        await redis.publish(
            GUARDRAIL_CONFIG_INVALIDATION_CHANNEL,
            json.dumps({"tenantId": "t-1", "taskKeys": ["guardrail.safety"]}),
        )
        for _ in range(50):
            if "guardrail.safety::t-1" not in resolver._cache:
                break
            await asyncio.sleep(0.01)
        assert set(resolver._cache) == {
            "guardrail.validate::t-1",
            "guardrail.availability::t-1",
            "guardrail.safety::t-2",
        }

        await redis.publish(GUARDRAIL_CONFIG_INVALIDATION_CHANNEL, json.dumps({"tenantId": "t-1"}))
        for _ in range(50):
            if "guardrail.validate::t-1" not in resolver._cache:
                break
            await asyncio.sleep(0.01)
        assert set(resolver._cache) == {"guardrail.safety::t-2"}

        await redis.publish(GUARDRAIL_CONFIG_INVALIDATION_CHANNEL, "")
        for _ in range(50):
            if not resolver._cache:
                break
            await asyncio.sleep(0.01)
        assert resolver._cache == {}
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
