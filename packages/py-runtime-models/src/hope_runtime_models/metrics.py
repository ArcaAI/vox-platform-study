"""TASK-529 §3.5 — the fixed Prometheus metric contract for model caches.

Metric names and label sets are a CONTRACT: one Grafana dashboard
(`infrastructure/grafana/dashboards/model-retention.json`) reads them across all
five services, so they must be identical everywhere.

    model_cache_loads_total{cache}
    model_cache_evictions_total{cache,reason="ttl|lru|vram"}
    model_cache_resident_models{cache}
    model_cache_resident_bytes_estimate{cache}
    vram_free_bytes{device}            # only when NVML is live

This module owns the metric DEFINITIONS but not the registry: each service
builds one sink against its own `core/metrics.py` registry, so the shared
package keeps zero hard dependency on `prometheus_client`.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

LOADS_TOTAL = "model_cache_loads_total"
EVICTIONS_TOTAL = "model_cache_evictions_total"
RESIDENT_MODELS = "model_cache_resident_models"
RESIDENT_BYTES_ESTIMATE = "model_cache_resident_bytes_estimate"
VRAM_FREE_BYTES = "vram_free_bytes"


class NullMetricsSink:
    """No-op sink — the default, and what tests use unless asserting metrics."""

    def on_load(self, name: str, key: str) -> None: ...

    def on_evict(self, name: str, key: str, reason: str) -> None: ...

    def on_resident(self, name: str, count: int, bytes_estimate: int) -> None: ...


class PrometheusMetricsSink:
    """Adapts the cache's callbacks onto pre-built prometheus_client metrics.

    Constructed by each service from ITS registry, so metric objects are created
    exactly once per process (re-registering the same name raises).

    Never raises: an observability failure must not take down a model load.
    """

    def __init__(
        self,
        *,
        loads_total: Any,
        evictions_total: Any,
        resident_models: Any,
        resident_bytes_estimate: Any,
    ) -> None:
        self._loads_total = loads_total
        self._evictions_total = evictions_total
        self._resident_models = resident_models
        self._resident_bytes_estimate = resident_bytes_estimate

    def on_load(self, name: str, key: str) -> None:
        try:
            self._loads_total.labels(cache=name).inc()
        except Exception:
            logger.debug("model_cache metrics on_load failed", exc_info=True)

    def on_evict(self, name: str, key: str, reason: str) -> None:
        try:
            self._evictions_total.labels(cache=name, reason=reason).inc()
        except Exception:
            logger.debug("model_cache metrics on_evict failed", exc_info=True)

    def on_resident(self, name: str, count: int, bytes_estimate: int) -> None:
        try:
            self._resident_models.labels(cache=name).set(count)
            self._resident_bytes_estimate.labels(cache=name).set(bytes_estimate)
        except Exception:
            logger.debug("model_cache metrics on_resident failed", exc_info=True)
