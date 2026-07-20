"""Shared model-lifecycle contract for the HOPE Python services (TASK-529 AD-4).

See the package README for the contract and its conformance clauses.
"""

from .cache import (
    EVICTION_REASONS,
    CacheStats,
    EvictionCount,
    MetricsSink,
    ModelCache,
    ModelUnavailableError,
    clamp_cache_ttl_seconds,
)
from .metrics import (
    EVICTIONS_TOTAL,
    LOADS_TOTAL,
    RESIDENT_BYTES_ESTIMATE,
    RESIDENT_MODELS,
    VRAM_FREE_BYTES,
    NullMetricsSink,
    PrometheusMetricsSink,
)
from .vram import make_vram_probe, reset_nvml_detection

__all__ = [
    "EVICTIONS_TOTAL",
    "EVICTION_REASONS",
    "LOADS_TOTAL",
    "RESIDENT_BYTES_ESTIMATE",
    "RESIDENT_MODELS",
    "VRAM_FREE_BYTES",
    "CacheStats",
    "EvictionCount",
    "MetricsSink",
    "ModelCache",
    "ModelUnavailableError",
    "NullMetricsSink",
    "PrometheusMetricsSink",
    "clamp_cache_ttl_seconds",
    "make_vram_probe",
    "reset_nvml_detection",
]
