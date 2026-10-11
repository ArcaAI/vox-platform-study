"""A `GuardrailEvaluationRecord` for EVERY screen, captured at least once (README §9.8.2).

Python twin of `packages/types/src/guardrail-evaluation.ts` (frozen by
`tests/contracts/guardrail-evaluation.fixture.json`). Guardrail's database access is
read-only by design, so it never writes the row itself (OD-14 (a), amended):

1. the screen route builds ONE record per request × direction — clean passes
   included — and :meth:`EvaluationOutbox.append` XADDs it to a bounded Redis stream
   BEFORE the route answers;
2. :class:`EvaluationDrainer` reads the stream as a consumer group and POSTs
   per-tenant batches of at most :data:`GUARDRAIL_EVALUATION_BATCH_MAX` to the
   gateway's ``POST internal/guardrail/evaluations`` (service token, ``X-Tenant-Id``
   equal to every record's ``tenantId``), which is idempotent on ``evaluationId``;
3. an entry is acknowledged (and deleted) only after a 2xx. A transport error or a
   5xx leaves it pending, and it is REDRIVEN (``XAUTOCLAIM``) once idle — a failed
   post is never dropped. A 4xx rejection (other than 408/429) is a poison record:
   it is dropped and counted, never redriven forever.

**A verdict never waits on, or changes because of, the capture path.** Every outbox
and drainer failure is logged and counted, never raised into a screen.

No judged text and no judge reasoning anywhere in a record: ``withheldContent`` is the
ONE content field, present only on an OUTBOUND BLOCK (README §9.7.6) — plaintext on
this internal wire, encrypted by the gateway before it is stored.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import Sequence
from typing import Any, Final

from prometheus_client import Counter

from guardrail.core.availability import CATALOGUE_DEFAULTS, MEDICAL_VALIDATION
from guardrail.core.logging import get_logger
from guardrail.services.notices import GuardrailCorrelation
from guardrail.services.screening import REASON_NOT_SELECTED

logger = get_logger(__name__)

#: Route under the gateway's global `api/v1` prefix (frozen).
GUARDRAIL_EVALUATIONS_PATH: Final = "internal/guardrail/evaluations"
#: Records per POST (frozen).
GUARDRAIL_EVALUATION_BATCH_MAX: Final = 100

GUARDRAIL_CALLERS: Final[tuple[str, ...]] = (
    "text.generate",
    "text.translate",
    "harness.guardrail_check",
    "playground",
    "governed_prompt",
)
GUARDRAIL_EVALUATION_EXEMPTIONS: Final[tuple[str, ...]] = ("medical_internal",)

OUTBOX_STREAM: Final = "guardrail:evaluations:outbox"
OUTBOX_GROUP: Final = "guardrail-evaluation-drainer"
_FIELD: Final = "record"

EVALUATIONS_PRODUCED = Counter(
    "guardrail_evaluation_outbox_produced_total",
    "Evaluation records appended to the outbox stream.",
)
EVALUATIONS_DRAINED = Counter(
    "guardrail_evaluation_outbox_drained_total",
    "Evaluation records the gateway acknowledged (2xx).",
)
EVALUATIONS_REDRIVEN = Counter(
    "guardrail_evaluation_outbox_redriven_total",
    "Evaluation records re-posted after an earlier failed attempt.",
)
EVALUATIONS_FAILED = Counter(
    "guardrail_evaluation_outbox_failed_total",
    "Evaluation capture failures, by stage (append | post | rejected | decode | unwired).",
    ["stage"],
)


def record_outbox_failure(stage: str, count: int = 1) -> None:
    try:
        EVALUATIONS_FAILED.labels(stage=stage).inc(count)
    except Exception:  # noqa: BLE001 — telemetry never breaks capture
        return


def uuid7() -> str:
    """An RFC 9562 version-7 UUID (time-ordered). Python 3.11 has no `uuid.uuid7`."""
    ms = int(time.time() * 1000) & ((1 << 48) - 1)
    rand = int.from_bytes(os.urandom(10), "big")
    value = (ms << 80) | (0x7 << 76) | (((rand >> 62) & 0xFFF) << 64) | (0b10 << 62)
    value |= rand & ((1 << 62) - 1)
    return str(uuid.UUID(int=value))


#: The `reason` of a flag taken at `ignore` — recorded only, never acted on (follow-up H).
REASON_RECORDED_AS_FINDING: Final = "recorded_as_finding"


def _items(refs: Sequence[tuple[str, int]]) -> list[dict[str, Any]]:
    return [{"itemId": str(item_id), "itemVersion": int(version)} for item_id, version in refs]


def _check_record(check: Any) -> dict[str, Any]:
    verdict = check.effective_verdict
    ran = verdict != "skipped"
    entry: dict[str, Any] = {"checkId": check.name, "verdict": verdict}
    if check.score is not None:
        entry["score"] = float(check.score)
    if verdict == "flag" and check.category:
        entry["category"] = str(check.category)
    if check.confidence is not None:
        entry["confidence"] = float(check.confidence)
    entry.update(
        {
            "actionTaken": check.effective_action_taken,
            "model": (check.model or None) if ran else None,
            "latencyMs": int(check.latency_ms) if ran else 0,
            "regionKeys": list(check.region_keys) if ran else [],
            "items": _items(check.items) if ran else [],
        }
    )
    # Follow-up H (additive): why a check did not act — a skipped / undetermined check's own
    # reason code, or `recorded_as_finding` for a flag taken at `ignore`. Never on any other.
    if verdict in ("skipped", "undetermined") and check.reason:
        entry["reason"] = str(check.reason)
    elif verdict == "flag" and entry["actionTaken"] == "ignore":
        entry["reason"] = REASON_RECORDED_AS_FINDING
    if verdict == "flag":
        # TASK-1063 item 5b (additive): which regions flagged, with their trust, label and score
        # — keys and labels only, never text. A check that carries no per-region detail names
        # the regions it acted on (else screened) under its category.
        regions = [region.to_dict() for region in getattr(check, "region_verdicts", ()) or ()]
        if not regions:
            label = str(check.category or check.name)
            score = float(check.score) if check.score is not None else None
            keys = list(check.flagged_regions) or list(check.region_keys)
            regions = [
                {"key": str(key), "trust": None, "label": label, "score": score} for key in keys
            ]
        if regions:
            entry["flaggedRegions"] = regions
    if getattr(check, "override_notice_id", None):
        # Additive (contract amendment 5d0760a60): this block was downgraded to a warn by
        # a VERIFIED `X-Hope-Guardrail-Override` naming this resolved notice.
        entry["override"] = True
        entry["noticeId"] = str(check.override_notice_id)
    return entry


def _skipped_record(check_id: str) -> dict[str, Any]:
    return {
        "checkId": check_id,
        "verdict": "skipped",
        "actionTaken": "none",
        "model": None,
        "latencyMs": 0,
        "regionKeys": [],
        "items": [],
        # A declared check the screen never produced is one this tenant did not turn on.
        "reason": REASON_NOT_SELECTED,
    }


def build_evaluation_record(
    decision: Any,
    *,
    tenant_id: str,
    correlation: GuardrailCorrelation,
    caller: str,
    notices: Sequence[dict[str, Any]],
    occurred_at: str,
    agent_slug: str | None = None,
    exempt: str | None = None,
    response_text: str | None = None,
    evaluation_id: str | None = None,
) -> dict[str, Any]:
    """One `GuardrailEvaluationRecord` (wire shape) for one decision.

    Every declared check of the direction is on the record: a check the screen did not
    run (a judge that is off) is a `skipped` entry, never an omission. The locked
    medical check is NOT invented here — `/api/medical/validate` decides it.
    """
    checks = [_check_record(check) for check in decision.checks]
    present = {entry["checkId"] for entry in checks}
    for check_id, default in CATALOGUE_DEFAULTS.items():
        if (
            decision.direction in default.directions
            and check_id not in present
            and check_id != MEDICAL_VALIDATION
        ):
            checks.append(_skipped_record(check_id))
    outcome = getattr(decision, "effective_decision", None) or decision.decision
    record: dict[str, Any] = {
        "evaluationId": evaluation_id or uuid7(),
        "tenantId": tenant_id,
        "requestId": correlation.request_id,
    }
    for name, value in (
        ("consultationId", correlation.consultation_id),
        ("runId", correlation.run_id),
        ("runKey", correlation.run_key),
        ("nodeId", correlation.node_id),
        ("itemId", correlation.item_id),
        ("agentSlug", agent_slug),
    ):
        if value:
            record[name] = value
    record["caller"] = caller if caller in GUARDRAIL_CALLERS else GUARDRAIL_CALLERS[0]
    record["direction"] = decision.direction
    record["decision"] = outcome
    if exempt in GUARDRAIL_EVALUATION_EXEMPTIONS:
        record["exempt"] = exempt
    record["checks"] = checks
    record["policyVersion"] = getattr(decision, "policy_version", "") or "unavailable"
    record["noticeIds"] = [str(notice["noticeId"]) for notice in notices]
    if notices:
        # Contract amendment 695df2b41: the FULL notices, so the gateway can persist them.
        record["notices"] = list(notices)
    if decision.direction == "outbound" and outcome == "block" and response_text is not None:
        record["withheldContent"] = response_text
    record["occurredAt"] = occurred_at
    return record


class EvaluationOutbox:
    """The bounded Redis-stream outbox. :meth:`append` never raises."""

    def __init__(
        self,
        redis: Any,
        *,
        maxlen: int = 100_000,
        approximate: bool = True,
        stream: str = OUTBOX_STREAM,
    ) -> None:
        self._redis = redis
        self._maxlen = maxlen
        self._approximate = approximate
        self.stream = stream

    async def append(self, record: dict[str, Any]) -> bool:
        try:
            await self._redis.xadd(
                self.stream,
                {_FIELD: json.dumps(record, separators=(",", ":"))},
                maxlen=self._maxlen,
                approximate=self._approximate,
            )
        except Exception as exc:  # noqa: BLE001 — capture never breaks a verdict
            record_outbox_failure("append")
            logger.warning(
                "guardrail.evaluation_outbox.append_failed",
                error_type=type(exc).__name__,
                tenant_id=record.get("tenantId"),
                evaluation_id=record.get("evaluationId"),
            )
            return False
        try:
            EVALUATIONS_PRODUCED.inc()
        except Exception:  # noqa: BLE001
            pass
        return True


def _decode(fields: Any) -> dict[str, Any] | None:
    if not isinstance(fields, dict):
        return None
    raw = fields.get(_FIELD)
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="replace")
    try:
        record = json.loads(raw) if isinstance(raw, str) else None
    except ValueError:
        return None
    if not isinstance(record, dict) or not str(record.get("tenantId") or "").strip():
        return None
    return record


class EvaluationDrainer:
    """Drains the outbox into the gateway, at least once, per-tenant batches."""

    def __init__(
        self,
        redis: Any,
        http_client: Any,
        *,
        gateway_url: str,
        token: str,
        consumer: str | None = None,
        batch_max: int = GUARDRAIL_EVALUATION_BATCH_MAX,
        redrive_idle_ms: int = 30_000,
        interval_s: float = 1.0,
        stream: str = OUTBOX_STREAM,
        group: str = OUTBOX_GROUP,
    ) -> None:
        self._redis = redis
        self._http = http_client
        self._url = f"{gateway_url.rstrip('/')}/{GUARDRAIL_EVALUATIONS_PATH}"
        self._token = token
        self._consumer = consumer or f"guardrail-{os.getpid()}"
        self._batch_max = max(1, min(int(batch_max), GUARDRAIL_EVALUATION_BATCH_MAX))
        self._redrive_idle_ms = max(0, int(redrive_idle_ms))
        self._interval_s = interval_s
        self._stream = stream
        self._group = group
        self._group_ready = False

    async def _ensure_group(self) -> None:
        if self._group_ready:
            return
        try:
            await self._redis.xgroup_create(self._stream, self._group, id="0", mkstream=True)
        except Exception as exc:  # noqa: BLE001 — BUSYGROUP means it already exists
            if "BUSYGROUP" not in str(exc):
                raise
        self._group_ready = True

    async def _claim_stale(self) -> list[tuple[str, Any]]:
        try:
            result = await self._redis.xautoclaim(
                self._stream,
                self._group,
                self._consumer,
                min_idle_time=self._redrive_idle_ms,
                start_id="0-0",
                count=self._batch_max,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "guardrail.evaluation_outbox.claim_failed", error_type=type(exc).__name__
            )
            return []
        entries = result[1] if isinstance(result, (list, tuple)) and len(result) > 1 else []
        return [(str(eid), fields) for eid, fields in entries if fields]

    async def _read_new(self, count: int) -> list[tuple[str, Any]]:
        if count <= 0:
            return []
        result = await self._redis.xreadgroup(
            self._group, self._consumer, {self._stream: ">"}, count=count
        )
        entries: list[tuple[str, Any]] = []
        for _stream, stream_entries in result or []:
            entries.extend((str(eid), fields) for eid, fields in stream_entries)
        return entries

    async def _settle(self, ids: Sequence[str]) -> None:
        if not ids:
            return
        await self._redis.xack(self._stream, self._group, *ids)
        await self._redis.xdel(self._stream, *ids)

    async def _post(self, tenant_id: str, records: list[dict[str, Any]]) -> str:
        """`ok` | `retry` | `rejected`."""
        try:
            response = await self._http.post(
                self._url,
                # The gateway's internal service-token guard identifies the caller by
                # `?service=` (TASK-1050 integration: W2e ingest contract).
                params={"service": "guardrail"},
                json={"evaluations": records},
                headers={
                    "X-Service-Token": self._token,
                    "X-Tenant-Id": tenant_id,
                    "Content-Type": "application/json",
                },
            )
        except Exception as exc:  # noqa: BLE001 — the gateway being down is a retry
            logger.warning(
                "guardrail.evaluation_outbox.post_failed",
                tenant_id=tenant_id,
                count=len(records),
                error_type=type(exc).__name__,
            )
            return "retry"
        status = int(getattr(response, "status_code", 0) or 0)
        if 200 <= status < 300:
            return "ok"
        if 400 <= status < 500 and status not in (408, 429):
            logger.error(
                "guardrail.evaluation_outbox.rejected",
                tenant_id=tenant_id,
                count=len(records),
                status=status,
            )
            return "rejected"
        logger.warning(
            "guardrail.evaluation_outbox.post_failed",
            tenant_id=tenant_id,
            count=len(records),
            status=status,
        )
        return "retry"

    async def drain_once(self) -> int:
        """One pass: redrive stale pending entries, then read new ones. Returns acked."""
        await self._ensure_group()
        stale = await self._claim_stale()
        fresh = await self._read_new(self._batch_max - len(stale))
        redriven_ids = {eid for eid, _f in stale}
        by_tenant: dict[str, list[tuple[str, dict[str, Any]]]] = {}
        poison: list[str] = []
        for eid, fields in [*stale, *fresh]:
            record = _decode(fields)
            if record is None:
                poison.append(eid)
                continue
            by_tenant.setdefault(str(record["tenantId"]), []).append((eid, record))
        if poison:
            record_outbox_failure("decode", len(poison))
            await self._settle(poison)

        acked = 0
        for tenant_id, entries in by_tenant.items():
            for start in range(0, len(entries), self._batch_max):
                chunk = entries[start : start + self._batch_max]
                ids = [eid for eid, _r in chunk]
                outcome = await self._post(tenant_id, [r for _e, r in chunk])
                redriven = sum(1 for eid in ids if eid in redriven_ids)
                if outcome == "ok":
                    await self._settle(ids)
                    acked += len(ids)
                    try:
                        EVALUATIONS_DRAINED.inc(len(ids))
                        if redriven:
                            EVALUATIONS_REDRIVEN.inc(redriven)
                    except Exception:  # noqa: BLE001
                        pass
                elif outcome == "rejected":
                    record_outbox_failure("rejected", len(ids))
                    await self._settle(ids)
                else:
                    # Left pending: XAUTOCLAIM redrives it once idle. Never dropped.
                    record_outbox_failure("post", len(ids))
        return acked

    async def run(self) -> None:
        """Drain forever; a failure backs off and retries, never stops the service."""
        while True:
            try:
                drained = await self.drain_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "guardrail.evaluation_outbox.drain_failed", error_type=type(exc).__name__
                )
                drained = 0
            if drained < self._batch_max:
                await asyncio.sleep(self._interval_s)


def start_evaluation_capture(
    app_state: Any, settings: Any, redis: Any, *, http_client: Any
) -> None:
    """Lifespan wiring: the outbox, its drainer task and the policy-invalidation subscriber.

    Construction performs no I/O; both tasks degrade quietly when Redis or the gateway
    is unreachable, so boot never blocks on (or fails because of) either. A
    pre-seeded ``app_state.evaluation_outbox`` (a test double) is kept as is.
    """
    from guardrail.core.tenant_config import guardrail_config_invalidation_listener

    policy = getattr(settings, "evaluation_outbox", None)
    maxlen = int(getattr(policy, "stream_maxlen", 100_000))
    if getattr(app_state, "evaluation_outbox", None) is None:
        app_state.evaluation_outbox = EvaluationOutbox(redis, maxlen=maxlen)
    drainer = EvaluationDrainer(
        redis,
        http_client,
        gateway_url=str(getattr(settings, "gateway_url", "")),
        token=settings.peer_service_token(settings.service_token),
        batch_max=int(getattr(policy, "batch_max", GUARDRAIL_EVALUATION_BATCH_MAX)),
        redrive_idle_ms=int(getattr(policy, "redrive_idle_ms", 30_000)),
        interval_s=float(getattr(policy, "drain_interval_s", 1.0)),
    )
    app_state.evaluation_drainer = drainer
    app_state.evaluation_drainer_task = asyncio.create_task(drainer.run())
    app_state.guardrail_config_invalidation_task = asyncio.create_task(
        guardrail_config_invalidation_listener(
            redis, getattr(app_state, "tenant_config_resolver", None)
        )
    )


async def stop_evaluation_capture(app_state: Any) -> None:
    """Cancel both lifespan tasks. Pending outbox entries stay in Redis for the next process."""
    for name in ("evaluation_drainer_task", "guardrail_config_invalidation_task"):
        task = getattr(app_state, name, None)
        if task is None:
            continue
        # Bounded and repeated: a Redis client may swallow a cancellation that lands
        # mid-connect, so one cancel is not a guarantee and shutdown must not wedge.
        for _attempt in range(3):
            if task.done():
                break
            task.cancel()
            await asyncio.wait({task}, timeout=2.0)
        if task.done() and not task.cancelled():
            task.exception()  # retrieve it, so it is never reported as unhandled
