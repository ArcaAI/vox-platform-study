"""The residency wiring stt's model cache is built with (TASK-1005).

One `Device` per process — every cache on it must share it, or the overlap
bookkeeping that makes a footprint attributable does not hold. The GPU when NVML
can see one (`make_vram_probe`'s probe, with its `libnvidia-ml` fallback), else the
host CPU. A time-sliced pod sees only its own card, as NVML index 0.

The metric objects are defined once per process here (re-registering a name
raises), on the default registry that `/metrics` on :8861 and the worker's
Dramatiq exporter on :9191 both expose.
"""

from __future__ import annotations

from functools import lru_cache

import prometheus_client
from hope_runtime_models import (
    CacheResidency,
    Device,
    PrometheusResidencyMetrics,
    default_device,
)

SERVICE = "stt"

RESIDENCY_METRICS = PrometheusResidencyMetrics.create(prometheus_client)


@lru_cache(maxsize=1)
def stt_device() -> Device:
    """This process's model device, probed once."""
    return default_device(0)


def stt_cache_residency() -> CacheResidency:
    """What `ModelCache` is constructed with. Admission stays OFF (the default)."""
    return CacheResidency(service=SERVICE, device=stt_device(), metrics=RESIDENCY_METRICS)
