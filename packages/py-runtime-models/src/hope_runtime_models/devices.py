"""The memory pools a model cache loads into — a GPU, or host RAM (TASK-1005).

A :class:`Device` answers two questions and keeps one piece of bookkeeping:

* ``memory()`` — how much of the pool is free / total right now (the residency
  report's ``devices[]`` and the admission check);
* ``usage()`` — a "bytes in use" reading whose DELTA around one load is that
  load's footprint: device-used bytes for a GPU (so the delta is the free-memory
  drop NVML sees), process RSS for the CPU;
* which loads and unloads are in progress on it, because a delta is only
  attributable to one load when nothing else moved memory at the same time.

Footprints are MEASURED, never estimated (plan D-2). A reading that cannot be
attributed — another load or unload overlapped, the probe is missing, or the
delta is not positive — is reported as unknown (``None``), never as a guess.

Several caches may share one device (nlp runs five caches on the host CPU), so
they must share one ``Device`` object for the overlap bookkeeping to hold.
"""

from __future__ import annotations

import importlib
import logging
import os
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, TypeVar

from .vram import DeviceMemory, make_vram_info_probe

logger = logging.getLogger(__name__)

DeviceKind = Literal["gpu", "cpu"]

R = TypeVar("R")


@dataclass(frozen=True)
class LoadToken:
    """One load in progress on a device (opaque to callers)."""

    key: str
    epoch: int
    clean_at_start: bool
    usage_before: int | None


class Device:
    """One memory pool, its probes, and the loads/unloads in flight on it."""

    def __init__(
        self,
        *,
        id: str,  # noqa: A002 — the contract's field name
        kind: DeviceKind,
        memory: Callable[[], DeviceMemory | None] | None = None,
        usage: Callable[[], int | None] | None = None,
    ) -> None:
        self.id = id
        self.kind: DeviceKind = kind
        self._memory = memory
        self._usage = usage
        self._lock = threading.Lock()
        #: Bumped by every load and unload START; a load whose start epoch is
        #: still current at its end overlapped nothing.
        self._epoch = 0
        self._active_loads: dict[str, int] = {}
        self._active_unloads = 0
        #: Operator/controller load intents (see :meth:`try_reserve`).
        self._reservations: dict[str, int] = {}

    # ── probes ──────────────────────────────────────────────────────────────

    def memory(self) -> DeviceMemory | None:
        """Free / total bytes now, or None when the pool cannot be read."""
        return _safe(self._memory, self.id)

    def usage(self) -> int | None:
        return _safe(self._usage, self.id)

    # ── load / unload bookkeeping ───────────────────────────────────────────

    def begin_load(self, key: str) -> LoadToken:
        with self._lock:
            clean = not self._active_loads and self._active_unloads == 0
            self._epoch += 1
            epoch = self._epoch
            self._active_loads[key] = self._active_loads.get(key, 0) + 1
        return LoadToken(key=key, epoch=epoch, clean_at_start=clean, usage_before=self.usage())

    def end_load(self, token: LoadToken, *, succeeded: bool) -> int | None:
        """Close a load; return its measured footprint in bytes, or None."""
        usage_after = self.usage() if succeeded else None
        with self._lock:
            clean = token.clean_at_start and self._epoch == token.epoch
            remaining = self._active_loads.get(token.key, 0) - 1
            if remaining > 0:
                self._active_loads[token.key] = remaining
            else:
                self._active_loads.pop(token.key, None)
        if not succeeded or not clean or token.usage_before is None or usage_after is None:
            return None
        delta = usage_after - token.usage_before
        return delta if delta > 0 else None

    def begin_unload(self) -> None:
        with self._lock:
            self._epoch += 1
            self._active_unloads += 1

    def end_unload(self) -> None:
        with self._lock:
            self._active_unloads = max(0, self._active_unloads - 1)

    def loading_keys(self) -> set[str]:
        """Keys with a load in progress or reserved on this device."""
        with self._lock:
            return set(self._active_loads) | set(self._reservations)

    def try_reserve(self, key: str) -> bool:
        """Claim the device for an explicit load of ``key``.

        Explicit loads are serialised per device so the footprint delta around
        each is attributable: refused (False) while ANOTHER key is loading or
        reserved; granted when idle or when ``key`` itself is already loading
        (the cache's single-flight then joins that load).
        """
        with self._lock:
            busy = (set(self._active_loads) | set(self._reservations)) - {key}
            if busy:
                return False
            self._reservations[key] = self._reservations.get(key, 0) + 1
            return True

    def release(self, key: str) -> None:
        with self._lock:
            remaining = self._reservations.get(key, 0) - 1
            if remaining > 0:
                self._reservations[key] = remaining
            else:
                self._reservations.pop(key, None)


def _safe(probe: Callable[[], R | None] | None, device_id: str) -> R | None:
    if probe is None:
        return None
    try:
        return probe()
    except Exception:  # noqa: BLE001 — a probe failure is "unknown", never a failed load
        logger.debug("hope_runtime_models.device_probe_failed device=%s", device_id, exc_info=True)
        return None


# ── concrete devices ────────────────────────────────────────────────────────


def gpu_device(index: int = 0) -> Device | None:
    """The NVML-probed GPU ``cuda:<index>``, or None when NVML is unavailable.

    ``index`` is the NVML index INSIDE the container: a time-sliced pod sees only
    the card it was given, as index 0.
    """
    probe = make_vram_info_probe(index)
    if probe is None:
        return None

    def usage() -> int:
        reading = probe()
        return reading.total_bytes - reading.free_bytes

    return Device(id=f"cuda:{index}", kind="gpu", memory=probe, usage=usage)


def cpu_device() -> Device:
    """Host RAM: node free/total for the report, process RSS for footprints."""
    return Device(id="cpu", kind="cpu", memory=host_memory, usage=process_rss_bytes)


def default_device(gpu_index: int = 0) -> Device:
    """The GPU when NVML can see one, else host RAM."""
    return gpu_device(gpu_index) or cpu_device()


def _psutil() -> Any:
    """`psutil` when installed (optional; stt declares it, nlp does not)."""
    return importlib.import_module("psutil")


def process_rss_bytes() -> int | None:
    """Resident set size of THIS process, in bytes (psutil, else /proc)."""
    try:
        return int(_psutil().Process().memory_info().rss)
    except Exception:  # noqa: BLE001 — fall through to /proc
        logger.debug("hope_runtime_models.psutil_rss_unavailable", exc_info=True)
    try:
        with open("/proc/self/statm", encoding="ascii") as statm:
            resident_pages = int(statm.read().split()[1])
        return resident_pages * os.sysconf("SC_PAGE_SIZE")
    except Exception:  # noqa: BLE001 — not Linux, or /proc unavailable
        return None


def host_memory() -> DeviceMemory | None:
    """Node-level available / total RAM (psutil, else /proc/meminfo)."""
    try:
        vm = _psutil().virtual_memory()
        return DeviceMemory(free_bytes=int(vm.available), total_bytes=int(vm.total))
    except Exception:  # noqa: BLE001 — fall through to /proc
        logger.debug("hope_runtime_models.psutil_memory_unavailable", exc_info=True)
    try:
        fields: dict[str, int] = {}
        with open("/proc/meminfo", encoding="ascii") as meminfo:
            for line in meminfo:
                name, _, rest = line.partition(":")
                fields[name] = int(rest.split()[0]) * 1024
        return DeviceMemory(free_bytes=fields["MemAvailable"], total_bytes=fields["MemTotal"])
    except Exception:  # noqa: BLE001 — not Linux, or /proc unavailable
        return None
