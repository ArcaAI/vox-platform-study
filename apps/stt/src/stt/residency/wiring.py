"""The residency wiring stt's model caches are built with (TASK-1005, TASK-1055).

One `Device` object per memory pool the process can place a model on — every
cache on a pool must share that object, or the overlap bookkeeping that makes a
footprint attributable does not hold. Since TASK-1055 that is EVERY GPU the
process sees (`gpu_devices()`: ``cuda:<i>`` = the i-th GPU in CUDA order, which the
deployment pins to PCI order with ``CUDA_DEVICE_ORDER=PCI_BUS_ID``), else the host
CPU. The default device — where sessions load and where an admin load without a
``device`` lands — is the first of them (``cuda:0``), exactly as before.

The metric objects are defined once per process here (re-registering a name
raises), on the default registry that `/metrics` on :8861 and the worker's
Dramatiq exporter on :9191 both expose. Every per-device cache shares them.
"""

from __future__ import annotations

from functools import lru_cache

import prometheus_client
from hope_runtime_models import (
    CacheResidency,
    Device,
    PrometheusResidencyMetrics,
    cpu_device,
    gpu_devices,
)

SERVICE = "stt"

RESIDENCY_METRICS = PrometheusResidencyMetrics.create(prometheus_client)


@lru_cache(maxsize=1)
def stt_devices() -> list[Device]:
    """Every device this process can place a model on, probed once (default first)."""
    return gpu_devices() or [cpu_device()]


@lru_cache(maxsize=1)
def stt_device() -> Device:
    """This process's DEFAULT model device (``cuda:0``, or the CPU without a GPU)."""
    return stt_devices()[0]


def stt_device_by_id(device_id: str) -> Device | None:
    """The shared `Device` named ``device_id`` (``cuda:<i>`` / ``cpu``), or None."""
    for device in stt_devices():
        if device.id == device_id:
            return device
    return None


def stt_cache_residency(device: Device | None = None) -> CacheResidency:
    """What a `ModelCache` is constructed with. Admission stays OFF (the default)."""
    return CacheResidency(service=SERVICE, device=device or stt_device(), metrics=RESIDENCY_METRICS)
