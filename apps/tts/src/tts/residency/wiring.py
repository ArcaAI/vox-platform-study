"""The residency wiring tts's local-engine caches are built with (TASK-1055 wave 3).

tts runs its self-hosted engines (Kokoro, Indic Parler, Indic F5) on the CPU, so every
cache shares ONE `Device` — host RAM — and the overlap bookkeeping that makes a
footprint attributable holds across them. The residency metric objects are defined
once per process, on the default registry `/metrics` exposes.
"""

from __future__ import annotations

from functools import lru_cache

import prometheus_client
from hope_runtime_models import CacheResidency, Device, PrometheusResidencyMetrics, cpu_device

SERVICE = "tts"

RESIDENCY_METRICS = PrometheusResidencyMetrics.create(prometheus_client)


@lru_cache(maxsize=1)
def tts_device() -> Device:
    """Host RAM — the only pool tts places a model on."""
    return cpu_device()


def tts_cache_residency(model_ref: str) -> CacheResidency:
    """What a local engine's `ModelCache` is constructed with. Admission stays OFF.

    ``model_ref`` labels the metrics: the AiModel slug the engine was built from (an
    engine's cache holds one entry, keyed by the engine name).
    """
    return CacheResidency(
        service=SERVICE,
        device=tts_device(),
        metrics=RESIDENCY_METRICS,
        model_ref=lambda _key: model_ref,
    )
