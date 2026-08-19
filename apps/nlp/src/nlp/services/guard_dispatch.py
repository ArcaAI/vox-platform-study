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

logger = structlog.get_logger(__name__)

_batchers: dict[str, MicroBatcher[Any, Any]] = {}
_lock = asyncio.Lock()


def _policy_fingerprint(*parts: Any) -> str:
    """A stable digest of everything that would change the answer."""
    blob = json.dumps(parts, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:16]


def pii_group_key(labels: list[str], threshold: float) -> str:
    return _policy_fingerprint("pii", labels, threshold)


def classify_group_key(tasks: dict[str, Any], threshold: float) -> str:
    return _policy_fingerprint("classify", tasks, threshold)


def _batching_config() -> dict[str, Any]:
    """Serving bounds. Env is the BOOTSTRAP FLOOR; the control plane may move
    the per-model concurrency ceiling at runtime via `inference_max_concurrent`.
    """
    service = settings.service
    return {
        "max_batch_size": service.inference_batch_max_size,
        "linger_ms": service.inference_batch_linger_ms,
        "max_queue": service.inference_queue_max_depth,
        "max_wait_s": service.inference_queue_max_wait_seconds,
        # One model's weights are a single shared tensor graph; the number of
        # forward passes allowed to be in flight against it at once is the
        # per-model concurrency bound, and it is deliberately small. Torch
        # already parallelises INSIDE a pass across cores, so stacking passes
        # buys contention, not throughput.
        "max_inflight_batches": service.inference_max_inflight_batches,
    }


async def get_batcher(
    slot_key: str,
    verb: str,
    run_batch: Any,
) -> MicroBatcher[Any, Any]:
    """The batcher for one (weight slot, verb), created once."""
    name = f"nlp_guard_{verb}"
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
                **_batching_config(),
            )
            _batchers[key] = batcher
            logger.info("nlp.guard_dispatch.batcher_created", batcher=name, slot=slot_key)
    return batcher


def live_batchers() -> dict[str, MicroBatcher[Any, Any]]:
    """Every instantiated batcher, for the queue-depth gauge."""
    return dict(_batchers)


async def reset_guard_batchers() -> None:
    """Close and drop every batcher (tests, and model-cache eviction)."""
    batchers, _batchers_snapshot = list(_batchers.values()), None  # noqa: F841
    _batchers.clear()
    for batcher in batchers:
        await batcher.aclose()
