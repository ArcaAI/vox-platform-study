"""Shared model-lifecycle contract for the HOPE Python services.

See the package README for the contract and its conformance clauses.
"""

from .cache import (
    EVICTION_REASONS,
    CacheStats,
    EvictionCount,
    MetricsSink,
    ModelCache,
    ModelUnavailableError,
    SyncModelCache,
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
from .resolvable import (
    PACKAGE_PROVIDED_LIBRARIES,
    ResolvableQuery,
    ResolvableResult,
    check_resolvable,
)
from .vram import make_vram_probe, reset_nvml_detection

__all__ = [
    "EVICTIONS_TOTAL",
    "EVICTION_REASONS",
    "LOADS_TOTAL",
    "PACKAGE_PROVIDED_LIBRARIES",
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
    "ResolvableQuery",
    "ResolvableResult",
    "SyncModelCache",
    "check_resolvable",
    "clamp_cache_ttl_seconds",
    "make_vram_probe",
    "reset_nvml_detection",
]
