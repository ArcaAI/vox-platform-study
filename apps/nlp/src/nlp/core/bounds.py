"""Bounded inference (TASK-1047 FC-8, lane L6).

One process-wide :class:`InferenceBounds`, refreshed from the control plane on
the same pull that already serves ``nlp.inference.maxConcurrent``
(``concurrency.refresh_inference_limit``). The numbers below are the frozen
FC-8 defaults; they are the floor the process runs on until the first
successful fetch, and what it keeps if the control plane is unreachable. The
descriptors that serve them are registered by lane L8.

* ``nlp.inference.maxInputChars``     -> :attr:`InferenceBounds.max_input_chars`
* ``nlp.inference.maxInputWords``     -> :attr:`InferenceBounds.max_input_words`
  (``max_len`` for gliner2: one forward pass otherwise spans the whole text)
* ``nlp.inference.maxBatchChars``     -> :attr:`InferenceBounds.max_batch_chars`
  (a micro-batch closes when its items' summed text length would exceed it)
* ``nlp.inference.threadsPerInference`` -> torch intra-op threads per inference
* ``nlp.worker.recycleAfterRequests`` / ``nlp.worker.recycleRssMib`` -> see
  :mod:`nlp.core.recycle`

THREAD PRECEDENCE. ``configure_torch_threading`` (``torch_runtime.py``) sizes the
pools once, at boot, from ``OMP_NUM_THREADS`` > ``NLP_TORCH_NUM_THREADS`` >
cgroup > affinity > ``os.cpu_count()``; that value is the process's CPU
BUDGET. ``threadsPerInference`` then divides the budget between the inferences
the semaphore lets run at once: an explicit value (> 0) is applied as-is,
``0`` means ``budget // inference_max_concurrent`` (min 1). So an operator's
``OMP_NUM_THREADS`` still bounds the total, and the per-inference share is
re-derived whenever the concurrency limit is resized.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from nlp.core.logging import get_logger

if TYPE_CHECKING:
    from nlp.core.effective_config import EffectiveConfigSnapshot

logger = get_logger(__name__)

INPUT_EXCEEDS_WINDOW = "INPUT_EXCEEDS_WINDOW"


class InputExceedsWindow(Exception):
    """A text longer than ``maxInputChars``. Mapped to 413 by the app handler."""

    def __init__(self, max_chars: int) -> None:
        super().__init__(f"input exceeds the {max_chars}-character window")
        self.max_chars = max_chars


@dataclass(frozen=True)
class InferenceBounds:
    max_input_chars: int = 8192
    max_input_words: int = 2048
    max_batch_chars: int = 8192  # per-forward-pass sum of item chars
    threads_per_inference: int = 0  # 0 = derive from CPU budget / concurrency
    recycle_after_requests: int = 2000
    recycle_rss_mib: int = 6144


_lock = threading.Lock()
_bounds = InferenceBounds()
_applied_threads: int | None = None


def get_bounds() -> InferenceBounds:
    return _bounds


def set_bounds(**changes: int) -> InferenceBounds:
    global _bounds
    with _lock:
        _bounds = replace(_bounds, **changes)
        return _bounds


def reset_bounds() -> None:
    global _bounds, _applied_threads
    with _lock:
        _bounds = InferenceBounds()
        _applied_threads = None


def enforce_input_cap(route: str, *texts: str) -> None:
    """Raise :class:`InputExceedsWindow` if any text is over the bound.

    Called BEFORE the inference semaphore and before any model is touched, and
    never truncates: the caller windows its input.
    """
    limit = _bounds.max_input_chars
    if any(len(text) > limit for text in texts):
        from nlp.core.metrics import NLP_INPUT_EXCEEDS_WINDOW_TOTAL

        NLP_INPUT_EXCEEDS_WINDOW_TOTAL.labels(route=route).inc()
        logger.warning("nlp.input_exceeds_window", route=route, max_chars=limit)
        raise InputExceedsWindow(limit)


def _positive_or_none(value: Any, *, allow_zero: bool = False) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    coerced = int(value)
    if coerced > 0 or (allow_zero and coerced == 0):
        return coerced
    return None


def apply_snapshot(snapshot: EffectiveConfigSnapshot) -> InferenceBounds:
    """Fold the control-plane values in. No opinion keeps what is in force."""
    mapping = (
        ("max_input_chars", "nlp.inference.maxInputChars", False),
        ("max_input_words", "nlp.inference.maxInputWords", False),
        ("max_batch_chars", "nlp.inference.maxBatchChars", False),
        ("threads_per_inference", "nlp.inference.threadsPerInference", True),
        ("recycle_after_requests", "nlp.worker.recycleAfterRequests", False),
        ("recycle_rss_mib", "nlp.worker.recycleRssMib", False),
    )
    changes: dict[str, int] = {}
    for attr, key, allow_zero in mapping:
        value = _positive_or_none(snapshot.setting(key), allow_zero=allow_zero)
        if value is not None:
            changes[attr] = value
    return set_bounds(**changes) if changes else _bounds


def resolve_threads_per_inference(configured: int, cpu_allowance: int, max_concurrent: int) -> int:
    """Explicit value wins; 0 means ``cpu_allowance // max_concurrent`` (min 1)."""
    if configured > 0:
        return configured
    return max(1, cpu_allowance // max(1, max_concurrent))


def _cpu_allowance() -> int:
    from hope_env.cpu import resolve_cpu_allowance

    from nlp.core.config import settings

    return resolve_cpu_allowance(override=settings.service.torch_num_threads).cpus


def _apply_torch_threads(threads: int) -> None:
    try:
        import torch
    except ImportError:
        return
    try:
        torch.set_num_threads(threads)
    except (RuntimeError, ValueError) as exc:
        logger.warning("nlp.threads.apply_failed", error=str(exc))


def apply_threads(max_concurrent: int) -> int:
    """Size torch's intra-op pool for ONE inference. Idempotent; never raises."""
    global _applied_threads
    try:
        threads = resolve_threads_per_inference(
            _bounds.threads_per_inference, _cpu_allowance(), max_concurrent
        )
        if threads != _applied_threads:
            _apply_torch_threads(threads)
            logger.info("nlp.threads.per_inference", threads=threads, max_concurrent=max_concurrent)
            _applied_threads = threads
        return threads
    except Exception as exc:  # noqa: BLE001 — a boot/config path must not break inference
        logger.warning("nlp.threads.resolve_failed", error=str(exc))
        return _applied_threads or 1
