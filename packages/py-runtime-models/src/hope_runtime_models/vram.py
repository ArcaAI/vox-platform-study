"""TASK-529 §3.4 — feature-detected NVML VRAM probe.

Decentralized budgets, no arbiter: each service bounds its own residency. A
cross-process arbiter was rejected in AD-4 as over-engineering — it is a new
failure domain, a deploy unit and an IPC protocol for a problem that static
partitioning solves on the only real deployment shape.

`pynvml` is imported INSIDE the probe and any failure disables it permanently,
so CPU-only hosts, missing drivers and CI all fall through to the estimate
budget. CI never depends on a GPU.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

logger = logging.getLogger(__name__)

_nvml_ready: bool | None = None


def _init_nvml() -> bool:
    """Initialise NVML once per process. False = unavailable, never retried."""
    global _nvml_ready
    if _nvml_ready is not None:
        return _nvml_ready

    try:
        import pynvml  # type: ignore[import-not-found]  # noqa: PLC0415 — lazy feature detection

        pynvml.nvmlInit()
        _nvml_ready = True
        logger.info("hope_runtime_models.nvml_available")
    except Exception as exc:  # noqa: BLE001 — any failure means "no probe"
        _nvml_ready = False
        logger.info("hope_runtime_models.nvml_unavailable reason=%s", exc)

    return _nvml_ready


def make_vram_probe(device_index: int = 0) -> Callable[[], int] | None:
    """Return a free-VRAM-bytes probe, or None when NVML is unavailable.

    None is the normal result on a CPU-only host — callers pass it straight to
    ``ModelCache(vram_probe=…)``, which then uses the estimates path.
    """
    if not _init_nvml():
        return None

    def probe() -> int:
        import pynvml  # noqa: PLC0415

        handle = pynvml.nvmlDeviceGetHandleByIndex(device_index)
        return int(pynvml.nvmlDeviceGetMemoryInfo(handle).free)

    return probe


def reset_nvml_detection() -> None:
    """Forget the cached detection result (tests only)."""
    global _nvml_ready
    _nvml_ready = None
