"""Per-model coalescing dispatch for the guardrail plane (TASK-778).

`nlp.core.batching.MicroBatcher` is the generic primitive; this module binds one
batcher per (weight slot, verb) and defines the GROUP KEY — the answer to "which
concurrent requests may legally ride the same forward pass".

The group key is the whole correctness argument. `gliner2` applies ONE label
schema and ONE threshold to every text in a batch, so two requests may share a
pass only if they agree on both. Batching across differing taxonomies would
return caller A's labels evaluated under caller B's policy — a wrong guardrail
verdict that looks entirely plausible. The key therefore fingerprints the full
policy, and the taxonomy travels inside the batch's own closure, never from a
literal here.

Batchers are keyed by the SAME `(model_name, model_path)` cache key the model
cache uses, so an admin flipping `AiModel.localPath` gets a fresh batcher along
with fresh weights rather than a queue still pointed at the old runtime.

TWO LANES OVER ONE WEIGHT SLOT (TASK-782)
-----------------------------------------
TASK-778 gave each (slot, verb) exactly one queue and measured p95 ~1.7 s at 100
concurrent — the right answer for the asynchronous per-utterance redaction pass
and the wrong one for a SYNCHRONOUS inline gate. The two are different service
classes with different latency budgets, so each (slot, verb) now carries two
batchers with their own geometry: `interactive` (small batch, ~2 ms linger,
short wait ceiling) and `bulk` (the TASK-778 geometry, unchanged).

Splitting the queues alone would not have been enough. Both lanes drive the SAME
tensor graph, so a bulk pass in flight is head-of-line blocking for the gate
however short the gate's queue is. The in-flight bound therefore moved OUT of
the batcher and onto a per-slot `PriorityGate` shared by both lanes: it keeps
the same ceiling on concurrent passes against one model, and hands a freed
permit to the interactive lane first. It is not pre-emption — a bulk pass
already running finishes — so the bulk lane's `max_batch_size` remains a
latency floor for the gate, and the ticket MEASURES that coupling instead of
asserting it away.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any

import structlog

from nlp.core.batching import MicroBatcher
from nlp.core.config import settings
from nlp.core.metrics import observe_batch_size
from nlp.core.priority_gate import PRIORITY_BULK, PRIORITY_INTERACTIVE, PriorityGate

logger = structlog.get_logger(__name__)

#: The two declared service classes. `bulk` is the DEFAULT so a caller that
#: names no class keeps exactly the TASK-778 behaviour.
LANE_INTERACTIVE = "interactive"
LANE_BULK = "bulk"
LANES = (LANE_INTERACTIVE, LANE_BULK)

_LANE_PRIORITY = {LANE_INTERACTIVE: PRIORITY_INTERACTIVE, LANE_BULK: PRIORITY_BULK}

_batchers: dict[str, MicroBatcher[Any, Any]] = {}
_gates: dict[str, PriorityGate] = {}
_lock = asyncio.Lock()


def normalize_lane(lane: str | None) -> str:
    """Map a caller-supplied class onto a declared lane; unknown ⇒ bulk.

    Deliberately permissive in ONE direction only: an unrecognised value gets
    the SLOWER lane. Defaulting an unknown class to the express lane would let a
    typo buy priority, which is exactly backwards for a shared resource.
    """
    value = (lane or "").strip().lower()
    return value if value in LANES else LANE_BULK


def _policy_fingerprint(*parts: Any) -> str:
    """A stable digest of everything that would change the answer."""
    blob = json.dumps(parts, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:16]


def pii_group_key(labels: list[str], threshold: float) -> str:
    return _policy_fingerprint("pii", labels, threshold)


def classify_group_key(tasks: dict[str, Any], threshold: float) -> str:
    return _policy_fingerprint("classify", tasks, threshold)


#: Control-plane batching geometry, keyed by lane (TASK-799 lane D).
_served_batching: dict[str, Any] = {}


async def apply_batching(served: dict[str, Any]) -> None:
    """Adopt control-plane queue/batch geometry, rebuilding batchers if it moved.

    A batcher captures its bounds at CONSTRUCTION, and they are constructed once
    per (weight slot, verb, lane) and then cached for the process's life — so
    storing new geometry without dropping them would leave the served value
    visible in config and absent from behaviour. Dropping them is cheap and safe:
    `reset_guard_batchers` drains in-flight work, and the next request rebuilds
    on the new bounds.

    A no-op when nothing changed, which is the overwhelmingly common case — this
    runs off the same cached snapshot every request already reads.
    """
    if not served or served == _served_batching:
        return
    _served_batching.clear()
    _served_batching.update(served)
    logger.info("nlp.guard_dispatch.batching_reconfigured", served=served)
    await reset_guard_batchers()


def _batching_config(lane: str) -> dict[str, Any]:
    """Serving bounds FOR ONE LANE — control plane over the env bootstrap floor.

    An omitted key keeps the floor value, so a gateway outage leaves the running
    geometry byte-identical rather than reverting a deliberate platform tuning.
    """
    floor = _batching_floor(lane)
    served = _served_batching.get(lane)
    if isinstance(served, dict):
        floor.update(served)
    return floor


def _batching_floor(lane: str) -> dict[str, Any]:
    """The bootstrap geometry this process starts on, before any fetch."""
    service = settings.service
    if lane == LANE_INTERACTIVE:
        return {
            "max_batch_size": service.inference_interactive_batch_max_size,
            "linger_ms": service.inference_interactive_batch_linger_ms,
            "max_queue": service.inference_interactive_queue_max_depth,
            # The ceiling IS the declared SLO: past it the verdict arrives too
            # late to gate anything, so a 503 the caller fails closed on beats a
            # stale 200 that has already been acted on.
            "max_wait_s": service.inference_interactive_queue_max_wait_seconds,
        }
    return {
        "max_batch_size": service.inference_batch_max_size,
        "linger_ms": service.inference_batch_linger_ms,
        "max_queue": service.inference_queue_max_depth,
        "max_wait_s": service.inference_queue_max_wait_seconds,
    }


def batch_size_for(lane: str) -> int:
    """The runtime `batch_size` argument this lane's forward passes carry."""
    return int(_batching_config(lane)["max_batch_size"])


def _gate_for(slot_key: str) -> PriorityGate:
    """The ONE in-flight bound for a weight slot, shared by both lanes.

    Per-batcher semaphores would double the passes in flight against one model
    the moment a second lane appeared, and would leave the gate no way to
    overtake a merely-QUEUED bulk pass.
    """
    limit = int(
        _served_batching.get(
            "max_inflight_batches", settings.service.inference_max_inflight_batches
        )
    )
    gate = _gates.get(slot_key)
    if gate is None or gate.limit != limit:
        # One model's weights are a single shared tensor graph; the number of
        # forward passes allowed in flight against it is deliberately small.
        # Torch already parallelises INSIDE a pass across cores, so stacking
        # passes buys contention, not throughput.
        gate = PriorityGate(limit)
        _gates[slot_key] = gate
    return gate


async def get_batcher(
    slot_key: str,
    verb: str,
    run_batch: Any,
    lane: str = LANE_BULK,
) -> MicroBatcher[Any, Any]:
    """The batcher for one (weight slot, verb, lane), created once.

    The lane rides in the batcher NAME, which is the label on every queue-depth,
    queue-wait and batch-size metric — so the two service classes are separately
    observable without touching a metric signature.
    """
    lane = normalize_lane(lane)
    name = f"nlp_guard_{verb}_{lane}"
    key = f"{name}::{slot_key}"
    batcher = _batchers.get(key)
    if batcher is not None:
        return batcher

    async with _lock:
        batcher = _batchers.get(key)
        if batcher is None:
            batcher = MicroBatcher(
                run_batch=run_batch,
                name=name,
                on_batch=lambda _group, size: observe_batch_size(name, size),
                inflight_gate=_gate_for(slot_key),
                priority=_LANE_PRIORITY[lane],
                **_batching_config(lane),
            )
            _batchers[key] = batcher
            logger.info(
                "nlp.guard_dispatch.batcher_created",
                batcher=name,
                slot=slot_key,
                lane=lane,
            )
    return batcher


def live_batchers() -> dict[str, MicroBatcher[Any, Any]]:
    """Every instantiated batcher, for the queue-depth gauge."""
    return dict(_batchers)


async def reset_guard_batchers() -> None:
    """Close and drop every batcher (tests, and model-cache eviction)."""
    batchers = list(_batchers.values())
    _batchers.clear()
    _gates.clear()
    for batcher in batchers:
        await batcher.aclose()
