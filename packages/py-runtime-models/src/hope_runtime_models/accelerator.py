"""Accelerator memory helpers shared by every residency-wired service (TASK-1055).

``release_accelerator_memory`` is what an unload hook calls AFTER it has dropped its
own references: without it torch's caching allocator keeps the freed blocks reserved,
the device's free memory never rises, and the next load's measured footprint is wrong
(the 2026-10-09 nlp finding E6/E7).

``torch_module_bytes`` sizes a loaded torch model from its parameters and buffers —
deterministic, and blind to other processes on a time-sliced card, unlike a
free-memory delta. ``None`` means "not a torch model I can size" (the caller then
falls back to the device delta).

torch is imported lazily: the package itself stays dependency-free.
"""

from __future__ import annotations

import gc
import importlib
import logging
import sys
from typing import Any

from .devices import cuda_index_of

logger = logging.getLogger(__name__)


def _torch() -> Any | None:
    try:
        return importlib.import_module("torch")
    except Exception:  # noqa: BLE001 — no torch in this service
        return None


def release_accelerator_memory(device_id: str | None = None) -> None:
    """``gc.collect()``, then hand torch's cached blocks on ``device_id`` back to the driver.

    ``device_id`` is ``cuda:<n>``.

    ``None`` or ``cpu`` only collects. Never raises: a failed release is logged and the
    unload still counts as done.
    """
    gc.collect()
    torch = _torch()
    if torch is None or device_id is None or not device_id.startswith("cuda"):
        return
    try:
        if not torch.cuda.is_available():
            return
        if ":" in device_id:
            index = int(device_id.split(":", 1)[1])
        else:
            index = torch.cuda.current_device()
        with torch.cuda.device(index):
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:  # noqa: BLE001 — releasing memory must never fail an unload
        logger.warning(
            "hope_runtime_models.release_failed", extra={"device": device_id}, exc_info=True
        )


def torch_reserved_bytes(device_id: str) -> int | None:
    """``torch.cuda.memory_reserved`` on ``cuda:<i>`` — only if torch is ALREADY imported.

    Never imports torch (a report must not pull it into a service that does not use it)
    and never initialises CUDA: None when torch is absent, CUDA is not initialised in
    this process, the id is not ``cuda:<i>``, or the read fails.
    """
    torch = sys.modules.get("torch")
    index = cuda_index_of(device_id)
    if torch is None or index is None:
        return None
    try:
        if not torch.cuda.is_initialized():
            return None
        return int(torch.cuda.memory_reserved(index))
    except Exception:  # noqa: BLE001 — a report reading is never worth an error
        return None


def torch_module_bytes(obj: Any) -> int | None:
    """Bytes held by the parameters and buffers of ``obj`` (or of ``obj.model``), else ``None``."""
    seen: set[int] = set()
    total = 0
    found = False
    for candidate in (obj, getattr(obj, "model", None), getattr(obj, "runtime", None)):
        if candidate is None or not hasattr(candidate, "parameters"):
            continue
        try:
            tensors = list(candidate.parameters())
            if hasattr(candidate, "buffers"):
                tensors += list(candidate.buffers())
        except Exception:  # noqa: BLE001, S112 — not a torch module after all
            continue
        for tensor in tensors:
            ident = id(tensor)
            if ident in seen:
                continue
            seen.add(ident)
            try:
                total += int(tensor.numel()) * int(tensor.element_size())
                found = True
            except Exception:  # noqa: BLE001, S112 — not a tensor
                continue
    return total if found else None
