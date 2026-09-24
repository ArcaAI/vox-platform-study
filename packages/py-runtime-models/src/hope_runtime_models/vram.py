"""Feature-detected NVML VRAM probe.

Decentralized budgets, no arbiter: each service bounds its own residency. A
cross-process arbiter was rejected as over-engineering — it is a new
failure domain, a deploy unit and an IPC protocol for a problem that static
partitioning solves on the only real deployment shape.

`pynvml` is imported INSIDE the probe and any failure disables it permanently,
so CPU-only hosts, missing drivers and CI all fall through to the estimate
budget. CI never depends on a GPU.

TASK-1005 — when the `pynvml` bindings are not installed (no service installs the
`nvml` extra today, and the stt GPU image does not ship it), the probe falls back
to calling the driver's own `libnvidia-ml.so.1` through `ctypes`. The NVIDIA
container runtime injects that library into every GPU container, so a GPU pod can
measure without a new dependency; a CPU pod has no such library and gets `None`,
exactly as before. Three NVML calls are used, all stable C ABI since NVML 5.
"""

from __future__ import annotations

import ctypes
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

_nvml_ready: bool | None = None
#: The ctypes NVML handle, when the fallback path initialised (None otherwise).
_nvml_lib: Any = None

_NVML_LIBRARIES = ("libnvidia-ml.so.1", "libnvidia-ml.so", "nvml.dll")


@dataclass(frozen=True)
class DeviceMemory:
    """One reading of a device's memory, in bytes."""

    free_bytes: int
    total_bytes: int


class _NvmlMemory(ctypes.Structure):
    """`nvmlMemory_t` — total / free / used, all `unsigned long long`."""

    _fields_ = [
        ("total", ctypes.c_ulonglong),
        ("free", ctypes.c_ulonglong),
        ("used", ctypes.c_ulonglong),
    ]


def _init_ctypes_nvml() -> Any:
    """Load and initialise the driver's NVML directly. None when absent."""
    for name in _NVML_LIBRARIES:
        try:
            lib = ctypes.CDLL(name)
        except OSError:
            continue
        if lib.nvmlInit_v2() != 0:
            return None
        return lib
    return None


def _init_nvml() -> bool:
    """Initialise NVML once per process. False = unavailable, never retried."""
    global _nvml_ready, _nvml_lib
    if _nvml_ready is not None:
        return _nvml_ready

    try:
        import pynvml  # type: ignore[import-not-found]  # noqa: PLC0415 — lazy feature detection

        pynvml.nvmlInit()
        _nvml_ready = True
        logger.info("hope_runtime_models.nvml_available")
    except Exception as exc:  # noqa: BLE001 — any failure means "try the driver library"
        try:
            _nvml_lib = _init_ctypes_nvml()
        except Exception:  # noqa: BLE001 — a broken driver library is "no probe" too
            _nvml_lib = None
        _nvml_ready = _nvml_lib is not None
        if _nvml_ready:
            logger.info("hope_runtime_models.nvml_available source=libnvidia-ml")
        else:
            logger.info("hope_runtime_models.nvml_unavailable reason=%s", exc)

    return _nvml_ready


def _read_memory(device_index: int) -> DeviceMemory:
    if _nvml_lib is not None:
        handle = ctypes.c_void_p()
        if _nvml_lib.nvmlDeviceGetHandleByIndex_v2(device_index, ctypes.byref(handle)) != 0:
            raise RuntimeError(f"nvmlDeviceGetHandleByIndex_v2({device_index}) failed")
        info = _NvmlMemory()
        if _nvml_lib.nvmlDeviceGetMemoryInfo(handle, ctypes.byref(info)) != 0:
            raise RuntimeError(f"nvmlDeviceGetMemoryInfo({device_index}) failed")
        return DeviceMemory(free_bytes=int(info.free), total_bytes=int(info.total))

    import pynvml  # noqa: PLC0415

    handle = pynvml.nvmlDeviceGetHandleByIndex(device_index)
    info = pynvml.nvmlDeviceGetMemoryInfo(handle)
    return DeviceMemory(free_bytes=int(info.free), total_bytes=int(info.total))


def make_vram_info_probe(device_index: int = 0) -> Callable[[], DeviceMemory] | None:
    """Return a free + total VRAM probe, or None when NVML is unavailable."""
    if not _init_nvml():
        return None

    def probe() -> DeviceMemory:
        return _read_memory(device_index)

    return probe


def make_vram_probe(device_index: int = 0) -> Callable[[], int] | None:
    """Return a free-VRAM-bytes probe, or None when NVML is unavailable.

    None is the normal result on a CPU-only host — callers pass it straight to
    ``ModelCache(vram_probe=…)``, which then uses the estimates path.
    """
    info = make_vram_info_probe(device_index)
    if info is None:
        return None

    def probe() -> int:
        return info().free_bytes

    return probe


def reset_nvml_detection() -> None:
    """Forget the cached detection result (tests only)."""
    global _nvml_ready, _nvml_lib
    _nvml_ready = None
    _nvml_lib = None
