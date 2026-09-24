"""The fixed Prometheus metric contract for model caches.

Metric names and label sets are a CONTRACT: one Grafana dashboard
(`infrastructure/grafana/dashboards/model-retention.json`) reads them across all
five services, so they must be identical everywhere.

    model_cache_loads_total{cache}
    model_cache_evictions_total{cache,reason="ttl|lru|vram"}
    model_cache_resident_models{cache}
    model_cache_resident_bytes_estimate{cache}
    vram_free_bytes{device}            # only when NVML is live

TASK-1005 adds the RESIDENCY contract — per MODEL rather than per cache, read by
the gateway residency controller and the "Model residency" console screen:

    model_resident{service,model,device,state="loading|loaded|unloading"}   # 1 / 0
    model_resident_bytes{service,model,device}   # MEASURED footprint; 0 = unmeasured
    model_load_seconds{service,model}            # histogram of successful loads
    model_evictions_total{service,reason="ttl|lru|pressure|admin|policy"}

The two eviction counters coexist on purpose: `model_cache_evictions_total` keeps
its three-value `reason` set (the retention dashboard reads exactly those), and
`model_evictions_total` says WHY at the residency grain — `pressure` is the
legacy `vram` plus admission room-making, `admin`/`policy` are explicit unloads
by an operator or by the controller's policy engine (both `lru` in the legacy set).

Gauges are zeroed rather than removed when a model leaves a state: a label set
removed in one process of a `PROMETHEUS_MULTIPROC_DIR` exporter (the stt Dramatiq
worker) would otherwise live on in the shared files.

This module owns the metric DEFINITIONS but not the registry: each service
builds one sink against its own `core/metrics.py` registry, so the shared
package keeps zero hard dependency on `prometheus_client`.
"""

from __future__ import annotations

import logging
from typing import Any, Protocol

logger = logging.getLogger(__name__)

LOADS_TOTAL = "model_cache_loads_total"
EVICTIONS_TOTAL = "model_cache_evictions_total"
RESIDENT_MODELS = "model_cache_resident_models"
RESIDENT_BYTES_ESTIMATE = "model_cache_resident_bytes_estimate"
VRAM_FREE_BYTES = "vram_free_bytes"

RESIDENT = "model_resident"
RESIDENT_BYTES = "model_resident_bytes"
MODEL_LOAD_SECONDS = "model_load_seconds"
RESIDENCY_EVICTIONS_TOTAL = "model_evictions_total"

#: Fixed label vocabularies of the residency contract.
RESIDENCY_STATES = ("loading", "loaded", "unloading")
RESIDENCY_EVICTION_REASONS = ("ttl", "lru", "pressure", "admin", "policy")

#: Cold loads measured on this platform run from ~1 s (an 84 MB embedder) to
#: ~100 s (a 5 GB LLM through LM Studio, TASK-1005 §10.1).
MODEL_LOAD_SECONDS_BUCKETS = (0.5, 1.0, 2.5, 5.0, 10.0, 20.0, 30.0, 60.0, 120.0, 300.0)


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


class ResidencyMetricsSink(Protocol):
    """What a residency-aware cache reports, per model."""

    def on_state(self, service: str, model: str, device: str, state: str | None) -> None: ...

    def on_bytes(self, service: str, model: str, device: str, measured: int | None) -> None: ...

    def on_load_seconds(self, service: str, model: str, seconds: float) -> None: ...

    def on_eviction(self, service: str, reason: str) -> None: ...


class PrometheusResidencyMetrics:
    """Adapts residency callbacks onto pre-built prometheus_client metrics.

    Build it ONCE per process with :meth:`create` (re-registering a name raises),
    handing in the host's own ``prometheus_client`` module so this package keeps
    no dependency on it. Never raises, like :class:`PrometheusMetricsSink`.
    """

    def __init__(
        self, *, resident: Any, resident_bytes: Any, load_seconds: Any, evictions_total: Any
    ) -> None:
        self._resident = resident
        self._resident_bytes = resident_bytes
        self._load_seconds = load_seconds
        self._evictions_total = evictions_total

    @classmethod
    def create(cls, prometheus_client: Any, *, registry: Any = None) -> PrometheusResidencyMetrics:
        """Define the four residency metrics on ``registry`` (default: the global one)."""
        extra = {} if registry is None else {"registry": registry}
        model_labels = ["service", "model", "device"]
        return cls(
            resident=prometheus_client.Gauge(
                RESIDENT,
                "1 while a model is in this residency state on this device, else 0",
                [*model_labels, "state"],
                multiprocess_mode="liveall",
                **extra,
            ),
            resident_bytes=prometheus_client.Gauge(
                RESIDENT_BYTES,
                "Measured device-memory footprint of a resident model (0 = not measured)",
                model_labels,
                multiprocess_mode="liveall",
                **extra,
            ),
            load_seconds=prometheus_client.Histogram(
                MODEL_LOAD_SECONDS,
                "Wall-clock seconds of a successful model load",
                ["service", "model"],
                buckets=MODEL_LOAD_SECONDS_BUCKETS,
                **extra,
            ),
            evictions_total=prometheus_client.Counter(
                RESIDENCY_EVICTIONS_TOTAL,
                "Model evictions by reason (ttl|lru|pressure|admin|policy)",
                ["service", "reason"],
                **extra,
            ),
        )

    def on_state(self, service: str, model: str, device: str, state: str | None) -> None:
        try:
            for candidate in RESIDENCY_STATES:
                self._resident.labels(
                    service=service, model=model, device=device, state=candidate
                ).set(1 if candidate == state else 0)
        except Exception:
            logger.debug("residency metrics on_state failed", exc_info=True)

    def on_bytes(self, service: str, model: str, device: str, measured: int | None) -> None:
        try:
            self._resident_bytes.labels(service=service, model=model, device=device).set(
                measured or 0
            )
        except Exception:
            logger.debug("residency metrics on_bytes failed", exc_info=True)

    def on_load_seconds(self, service: str, model: str, seconds: float) -> None:
        try:
            self._load_seconds.labels(service=service, model=model).observe(seconds)
        except Exception:
            logger.debug("residency metrics on_load_seconds failed", exc_info=True)

    def on_eviction(self, service: str, reason: str) -> None:
        try:
            self._evictions_total.labels(service=service, reason=reason).inc()
        except Exception:
            logger.debug("residency metrics on_eviction failed", exc_info=True)
