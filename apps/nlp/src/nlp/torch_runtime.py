"""Size PyTorch's CPU thread pools from the container's quota — before torch loads.

WHY THIS MODULE IS IMPORTED FROM ``nlp/__init__.py`` AND NOT FROM AN ENTRY POINT
================================================================================

``OMP_NUM_THREADS`` / ``MKL_NUM_THREADS`` are read by the OpenMP runtime when
torch is IMPORTED, not when a tensor is created. A hook that runs after the
first ``import torch`` anywhere in the process is a silent no-op that still
looks green — the log line prints, the numbers look right, and the pool is
already the wrong size.

``apps/nlp`` has two entry paths and the container uses neither ``main.py`` nor
``app.py`` as the FIRST module loaded:

* the image's ``ENTRYPOINT`` is ``python -m uvicorn --factory nlp.app:get_app``,
  which imports the ``nlp`` PACKAGE and only then ``nlp.app``;
* local dev runs ``nlp.main:main``, whose ``uvicorn.run("nlp.app:get_app",
  workers=N, factory=True)`` re-imports the same app string in every worker
  child — each of those is a fresh interpreter that must configure itself.

``nlp/__init__.py`` is the ONE module Python guarantees to execute before any
``nlp.*`` submodule in every one of those cases, and no torch import in this
service happens anywhere but inside an ``nlp.*`` module
(``nlp.core.device``, ``nlp.services.{token,text}_classifier``,
``nlp.services.medical_suggester``). That is what makes the placement sound
rather than merely early. ``tests/test_torch_threading_task892.py`` proves it
by starting a real process the way the container does and reading the value
back out of torch.

WHAT IT FIXES (TASK-892 D-1)
===========================

``hope-nlp`` ran a 48-thread intra-op pool inside a 2-CPU CFS quota: 48 runnable
threads exhaust a 200 ms quota in a few milliseconds, then the whole pool
freezes for the rest of every 100 ms period, and the OpenMP barrier across 48
threads costs more than the GEMM it surrounds. Measured in-pod: 7,292 s frozen
against 573 s executing, and 583.3 ms/layer against 50.0 ms at 8 threads.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from hope_env.cpu import OMP_NUM_THREADS_VAR, resolve_cpu_allowance

from nlp.core.logging import get_logger

__all__ = ["MKL_NUM_THREADS_VAR", "TorchThreadingPlan", "configure_torch_threading"]

logger = get_logger(__name__)

MKL_NUM_THREADS_VAR = "MKL_NUM_THREADS"

#: One inter-op thread. This service runs sequential encoder forward passes; a
#: second inter-op pool buys no parallelism and contends for the same quota.
DEFAULT_INTEROP_THREADS = 1


@dataclass(frozen=True)
class TorchThreadingPlan:
    """What was decided, and where the number came from."""

    threads: int
    interop_threads: int
    #: The step of `hope_env.cpu`'s chain that produced `threads` — "cgroup-v2",
    #: "override", "OMP_NUM_THREADS", "cpu_count", ... Logged because "2 threads
    #: because the cgroup says 2" and "2 threads because this host has 2 cores"
    #: are different facts, and only the first survives a move to a bigger node.
    source: str
    #: False when torch is not installed, or refused the change.
    applied: bool


def _apply_to_torch(threads: int, interop_threads: int) -> bool:
    """Set the pools on torch itself. Never raises — this is a boot path."""
    try:
        import torch
    except ImportError:
        logger.info(
            "torch not installed - OMP/MKL exported only (threads=%s)",
            threads,
        )
        return False

    applied = True
    try:
        torch.set_num_threads(threads)
    except (RuntimeError, ValueError) as exc:
        logger.warning("Failed to set torch intra-op threads: %s", exc)
        applied = False

    try:
        torch.set_num_interop_threads(interop_threads)
    except (RuntimeError, ValueError) as exc:
        # torch refuses this once parallel work has started, which is the normal
        # outcome of a second call in the same process. Not a failure worth
        # aborting a service start for.
        logger.warning("Failed to set torch inter-op threads: %s", exc)

    return applied


def configure_torch_threading() -> TorchThreadingPlan:
    """Resolve, export and apply the CPU thread configuration. Idempotent.

    Precedence (``hope_env.cpu.resolve_cpu_allowance``):
    ``OMP_NUM_THREADS`` > ``NLP_TORCH_NUM_THREADS`` > cgroup v2 > cgroup v1 >
    ``sched_getaffinity`` > ``os.cpu_count()``.

    An operator's ``OMP_NUM_THREADS`` deliberately outranks the service setting
    AND the cgroup: it is how the running deployment is tuned without a rebuild
    (the interim ``overlays/dev`` mitigation sets exactly that), and a fix that
    quietly reverted an operator's value would be its own defect.
    """
    # Imported here rather than at module scope: this module is imported from
    # `nlp/__init__.py`, i.e. while the `nlp` package is still initialising.
    from nlp.core.config import settings

    service = settings.service
    allowance = resolve_cpu_allowance(override=service.torch_num_threads)
    interop_threads = service.torch_num_interop_threads or DEFAULT_INTEROP_THREADS

    # Export BEFORE any torch import (see the module docstring), and never over
    # an existing value — an empty string counts as unset, since that is what a
    # `secretKeyRef`/env binding leaves behind when its source is missing.
    for var in (OMP_NUM_THREADS_VAR, MKL_NUM_THREADS_VAR):
        if not os.environ.get(var, "").strip():
            os.environ[var] = str(allowance.cpus)

    applied = _apply_to_torch(allowance.cpus, interop_threads)

    logger.info(
        "PyTorch threading configured: threads=%s interop=%s source=%s applied=%s",
        allowance.cpus,
        interop_threads,
        allowance.source,
        applied,
    )
    return TorchThreadingPlan(
        threads=allowance.cpus,
        interop_threads=interop_threads,
        source=allowance.source,
        applied=applied,
    )
