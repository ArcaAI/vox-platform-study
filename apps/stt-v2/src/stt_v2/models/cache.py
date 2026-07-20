"""Model cache with LRU eviction and TTL support.

TASK-530 (R2, completing GAP-L1) — the retention POLICY (single-flight load,
idle TTL clamped to [60s, 3600s], pin/unpin refcounting, LRU bound, memory
budget, periodic sweep, VRAM-aware eviction, unload-on-every-eviction-path) now
lives in the shared contract `hope_runtime_models.ModelCache`, which every HOPE
service composes. See `packages/py-runtime-models/README.md`.

This module is the stt-v2-facing surface of that contract. It keeps EVERY public
spelling stt-v2 callers and tests already use — `get()` as a peek, `put()`,
`get_or_load*()`, the stt-v2 `CacheEntry`/`CacheStats` shapes, `_loaders`,
`apply_retention` — and nothing else: the ~150-line local copy of the policy is
gone. TASK-529 deferred this refactor deliberately (567 lines on the ASR hot
path, late in a large ticket); the parity gate for it is
`tests/unit/test_model_cache.py` + `test_model_cache_ttl.py` passing UNMODIFIED.

Two spellings differ from the shared contract on purpose, because stt-v2's API
predates it and its callers depend on them:

* ``get(slug)`` is a PEEK returning ``LoadedModel | None`` — it never loads.
  The contract's get-or-load path is ``get_or_load(config)``, which is what
  delegates to the shared single-flight machinery.
* entries are surfaced through ``_cache`` as `CacheEntry` objects carrying
  ``datetime`` timestamps; the shared core stores monotonic floats. `_cache` is
  a live view that converts in both directions, so mutating an entry through it
  still steers the policy.
"""

import logging
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from hope_runtime_models import ModelCache as SharedModelCache
from hope_runtime_models import clamp_cache_ttl_seconds

from ..core.config.settings import get_settings
from ..core.exceptions import ModelLoadError
from ..core.metrics import build_model_cache_metrics_sink
from ..pipeline.dto import AiModelConfig, AiModelFormat, InlineModelDef, ModelRef, ModelTaskType
from .azure_foundry_loader import AzureFoundryLoader
from .azure_speech_loader import AzureSpeechLoader
from .base_loader import BaseModelLoader, LoadedModel
from .faster_whisper_loader import FasterWhisperLoader
from .huggingface_loader import HuggingFaceLoader
from .nemo_loader import NeMoLoader
from .onnx_loader import ONNXLoader
from .parakeet_cpp_loader import ParakeetCppLoader
from .whisper_cpp_loader import WhisperCppLoader

logger = logging.getLogger(__name__)


# TASK-525 — control-plane retention refresher, installed at app startup so the
# cache never hard-depends on HTTP (see `ModelCache._refresh_retention`).
_retention_refresher: Callable[[], Awaitable[None]] | None = None


def set_retention_refresher(refresher: Callable[[], Awaitable[None]] | None) -> None:
    """Install (or clear, with None) the control-plane retention refresher."""
    global _retention_refresher
    _retention_refresher = refresher


@dataclass
class CacheEntry:
    """Cache entry with metadata."""

    model: LoadedModel
    loaded_at: datetime
    last_accessed: datetime
    access_count: int = 0
    pin_count: int = 0

    @property
    def age_seconds(self) -> float:
        """Get age of cache entry in seconds."""
        return (datetime.utcnow() - self.loaded_at).total_seconds()

    @property
    def idle_seconds(self) -> float:
        """Get time since last access in seconds."""
        return (datetime.utcnow() - self.last_accessed).total_seconds()

    @property
    def is_pinned(self) -> bool:
        """True while at least one active session/job holds a pin."""
        return self.pin_count > 0


@dataclass
class CacheStats:
    """Cache statistics."""

    total_models: int
    total_memory_mb: int
    max_models: int
    max_memory_mb: int
    hits: int
    misses: int
    evictions: int
    models: list[dict[str, Any]] = field(default_factory=list)

    @property
    def hit_rate(self) -> float:
        """Calculate cache hit rate."""
        total = self.hits + self.misses
        return self.hits / total if total > 0 else 0.0


class _BoundCacheEntry(CacheEntry):
    """A live `CacheEntry` view of one shared-core entry.

    Reads convert the core's monotonic ``last_accessed`` to a ``datetime``;
    writes convert back and land on the core entry, so ageing an entry through
    this view really does make the policy evict it. Instantiated per lookup —
    it holds no state of its own beyond the two references.
    """

    def __init__(self, cache: "ModelCache", slug: str, entry: Any) -> None:
        self._cache = cache
        self._slug = slug
        self._entry = entry

    @property
    def model(self) -> LoadedModel:
        instance: LoadedModel = self._entry.instance
        return instance

    @model.setter
    def model(self, value: LoadedModel) -> None:
        self._entry.instance = value

    @property
    def last_accessed(self) -> datetime:
        return self._cache._as_datetime(self._entry.last_accessed)

    @last_accessed.setter
    def last_accessed(self, value: datetime) -> None:
        self._entry.last_accessed = self._cache._as_monotonic(value)

    @property
    def loaded_at(self) -> datetime:
        return self._cache._loaded_at.get(self._slug, datetime.utcnow())

    @loaded_at.setter
    def loaded_at(self, value: datetime) -> None:
        self._cache._loaded_at[self._slug] = value

    @property
    def access_count(self) -> int:
        return self._cache._access_counts.get(self._slug, 0)

    @access_count.setter
    def access_count(self, value: int) -> None:
        self._cache._access_counts[self._slug] = value

    @property
    def pin_count(self) -> int:
        pins: int = self._entry.pin_count
        return pins

    @pin_count.setter
    def pin_count(self, value: int) -> None:
        self._entry.pin_count = value


class _CacheEntryView:
    """The legacy ``cache._cache`` mapping, backed by the shared core's entries."""

    def __init__(self, cache: "ModelCache") -> None:
        self._cache = cache

    def __contains__(self, slug: object) -> bool:
        return slug in self._cache._entries

    def __len__(self) -> int:
        return len(self._cache._entries)

    def __iter__(self) -> Iterator[str]:
        return iter(self._cache._entries)

    def keys(self) -> Iterator[str]:
        return iter(self._cache._entries)

    def __getitem__(self, slug: str) -> _BoundCacheEntry:
        return _BoundCacheEntry(self._cache, slug, self._cache._entries[slug])

    def get(self, slug: str, default: Any = None) -> Any:
        entry = self._cache._entries.get(slug)
        return default if entry is None else _BoundCacheEntry(self._cache, slug, entry)

    def __setitem__(self, slug: str, entry: CacheEntry) -> None:
        """Install an entry directly (fixtures / tests): datetimes → monotonic."""
        self._cache._loaded_at[slug] = entry.loaded_at
        self._cache._access_counts[slug] = entry.access_count
        self._cache._memory_estimates[slug] = entry.model.memory_mb
        self._cache._install_entry(slug, entry.model, entry.last_accessed)


class ModelCache(SharedModelCache[LoadedModel]):
    """LRU cache with TTL for loaded models — stt-v2's skin on the shared policy.

    NOTE the deliberate spelling difference from the shared contract: ``get`` is
    stt-v2's long-standing PEEK (returns None on a miss, never loads) and
    ``get_or_load`` is the loading path. Nothing inside the shared core calls
    ``self.get``, so the override is contained to this class's public API.
    """

    def __init__(
        self,
        max_memory_mb: int | None = None,
        max_models: int | None = None,
        ttl_seconds: int | None = None,
    ):
        """
        Initialize model cache.

        Args:
            max_memory_mb: Maximum memory for cached models
            max_models: Maximum number of models
            ttl_seconds: TTL for cached models
        """
        settings = get_settings()

        # TASK-525 — these three are BOOTSTRAP FALLBACKS; their runtime values
        # come from the control plane via `apply_retention` below. Note
        # `max_memory_mb` has no settings field at all — this literal is the only
        # default it has ever had, and the registry descriptor deliberately
        # mirrors it rather than the divergent seed row (see DR-2).
        raw_ttl = ttl_seconds if ttl_seconds is not None else settings.model_cache_ttl_seconds

        # Per-slug side tables the shared core does not model: stt-v2 surfaces
        # `loaded_at` / `access_count` in `/internal/cache/stats`, and the memory
        # budget is expressed in MB rather than bytes.
        self._loaded_at: dict[str, datetime] = {}
        self._access_counts: dict[str, int] = {}
        self._memory_estimates: dict[str, int] = {}
        # Slug → the config of a load in flight (the shared factory is keyed by
        # slug alone and cannot reconstruct one).
        self._pending_configs: dict[str, AiModelConfig] = {}

        super().__init__(
            factory=self._load_by_slug,
            unload=self._unload_model,
            ttl_seconds=raw_ttl,
            max_size=max_models or settings.model_cache_max_models,
            max_bytes_estimate=max_memory_mb or 10000,  # Default 10GB
            estimate_bytes=self._memory_estimates.get,  # type: ignore[arg-type]
            metrics=build_model_cache_metrics_sink(),
            name="stt_model_cache",
        )

        self._cache = _CacheEntryView(self)

        # Model loaders - map format/engine to appropriate loader
        self._loaders: dict[AiModelFormat, BaseModelLoader] = {
            AiModelFormat.SAFETENSOR: HuggingFaceLoader(),
            AiModelFormat.PYTORCH: HuggingFaceLoader(),
            AiModelFormat.ONNX: ONNXLoader(),
            AiModelFormat.ONNX_OPTIMUM: ONNXLoader(),  # HuggingFace Optimum ONNX uses same loader
            AiModelFormat.NEMO: NeMoLoader(),
            AiModelFormat.CTRANSLATE2: HuggingFaceLoader(),  # Legacy alias — transformers path
            # TASK-351 P1-2 — faster-whisper on CTranslate2 (lazy import)
            AiModelFormat.FASTER_WHISPER: FasterWhisperLoader(),
            AiModelFormat.AZURE_SPEECH: AzureSpeechLoader(),  # Cloud-based Azure Cognitive Services
            # TASK-505 P3 — new engines (both lazy at load time).
            AiModelFormat.AZURE_FOUNDRY: AzureFoundryLoader(),
            AiModelFormat.PARAKEET_CPP: ParakeetCppLoader(),
            # TASK-507 — whisper.cpp (lazy at load time).
            AiModelFormat.WHISPER_CPP: WhisperCppLoader(),
        }

        logger.info(
            f"ModelCache initialized: max_models={self._max_size}, "
            f"max_memory_mb={self._max_bytes_estimate}, ttl_seconds={self._ttl_seconds}"
        )

    # ── legacy internal spellings ───────────────────────────────────────────
    # The shared core calls these `_max_size` / `_max_bytes_estimate`. stt-v2's
    # own names are kept as live aliases so nothing that reads them has to move.

    @property
    def _max_models(self) -> int:
        return self._max_size

    @_max_models.setter
    def _max_models(self, value: int) -> None:
        self._max_size = value

    @property
    def _max_memory_mb(self) -> int:
        return self._max_bytes_estimate or 0

    @_max_memory_mb.setter
    def _max_memory_mb(self, value: int) -> None:
        self._max_bytes_estimate = value

    # ── datetime ⇄ monotonic bridge ─────────────────────────────────────────

    def _as_datetime(self, monotonic: float) -> datetime:
        """The wall-clock instant a monotonic reading corresponds to, now."""
        return datetime.utcnow() - timedelta(seconds=self._time() - monotonic)

    def _as_monotonic(self, when: datetime) -> float:
        """The monotonic reading a wall-clock instant corresponds to, now."""
        return self._time() - (datetime.utcnow() - when).total_seconds()

    def _install_entry(self, slug: str, model: LoadedModel, last_accessed: datetime) -> None:
        """Seat an entry with an explicit idle age (used by the `_cache` view)."""
        self._admit_locked(slug, model)
        self._entries[slug].last_accessed = self._as_monotonic(last_accessed)

    # ── shared-core hooks ───────────────────────────────────────────────────

    def _lookup_locked(self, key: str) -> tuple[LoadedModel | None, list[tuple[str, LoadedModel]]]:
        hit, victims = super()._lookup_locked(key)
        if hit is not None:
            self._access_counts[key] = self._access_counts.get(key, 0) + 1
            logger.debug(f"Cache hit for model {key}")
        return hit, victims

    def _admit_locked(
        self, key: str, instance: LoadedModel
    ) -> tuple[list[tuple[str, LoadedModel]], int, int]:
        # The config's `memory_size_mb` is only a hint for pre-load pressure
        # relief; the loaded model knows its real footprint.
        self._memory_estimates[key] = instance.memory_mb
        self._loaded_at[key] = datetime.utcnow()
        self._access_counts[key] = 1
        result = super()._admit_locked(key, instance)
        logger.info(
            f"Cached model {key} (memory={instance.memory_mb}MB, "
            f"total_cached={len(self._entries)})"
        )
        return result

    def _evict_locked(self, key: str, *, reason: str) -> list[tuple[str, LoadedModel]]:
        victims = super()._evict_locked(key, reason=reason)
        if victims:
            self._loaded_at.pop(key, None)
            self._access_counts.pop(key, None)
            self._memory_estimates.pop(key, None)
        return victims

    async def _load_by_slug(self, slug: str) -> LoadedModel:
        """Shared-cache factory: resolve the loader for the pending config and load."""
        model_config = self._pending_configs[slug]
        loader = self._get_loader(model_config.format)
        if loader is None:
            raise ModelLoadError(f"No loader available for format: {model_config.format}")

        logger.info(f"Loading model {slug} (format={model_config.format})")
        return await loader.load(model_config)

    async def _unload_model(self, slug: str, model: LoadedModel) -> None:
        """Release an evicted model through its format's loader."""
        loader = self._get_loader(model.format)
        if loader is not None:
            await loader.unload(model)
        logger.info(f"Evicted model {slug} (memory={model.memory_mb}MB)")

    # ── control-plane retention ─────────────────────────────────────────────

    def apply_retention(self, retention: dict[str, int]) -> None:
        """TASK-525 — adopt control-plane retention values.

        An ABSENT key keeps the current (env/bootstrap) value — so a gateway
        outage leaves behaviour byte-identical to today. Resident models are
        never dropped: new limits take effect on the next eviction pass. The
        product clamp [60, 3600] is re-applied inside the shared cache as well
        as server-side — a bad DB value must not be able to push the cache
        outside its supported window.
        """
        self.configure(
            ttl_seconds=retention.get("ttl_seconds"),
            max_size=retention.get("max_models"),
            max_bytes_estimate=retention.get("max_memory_mb"),
        )

    async def _refresh_retention(self) -> None:
        """Pull + apply control-plane retention, if a refresher is installed.

        UNSET by default and installed at app startup (`set_retention_refresher`),
        so the cache itself never depends on HTTP: unit tests and any non-served
        context exercise the cache with zero network I/O, and only a running app
        opts into the control-plane pull.
        """
        if _retention_refresher is None:
            return
        await _retention_refresher()

    # ── the stt-v2 public surface ───────────────────────────────────────────

    async def get(self, model_slug: str) -> LoadedModel | None:  # type: ignore[override]
        """Peek the cache and update LRU order — NEVER loads (see class docstring).

        Args:
            model_slug: Model slug

        Returns:
            LoadedModel if cached, None otherwise
        """
        async with self._lock:
            hit, victims = self._lookup_locked(model_slug)
        await self._run_unloads(victims)
        return hit

    async def get_or_load(self, model_config: AiModelConfig) -> LoadedModel:
        """
        Get model from cache or load it — single-flight per slug
        (TASK-351 P0-3 / H1, now the shared contract's single-flight).

        The expensive `loader.load()` runs OUTSIDE the cache lock (so cache
        hits for other models are never blocked behind a load), but
        concurrent callers for the same slug share one load via an in-flight
        future instead of each loading their own copy.

        Args:
            model_config: Model configuration

        Returns:
            LoadedModel
        """
        slug = model_config.slug

        # TASK-525 — read-triggered control-plane refresh. Cached inside the
        # client's TTL window (so this is ~free), never raises, and runs BEFORE
        # the eviction pass below so a freshly-served retention value applies to
        # this load rather than the next one.
        await self._refresh_retention()

        self._pending_configs[slug] = model_config
        # The declared size is the only footprint known BEFORE the load, so it
        # is what pre-load pressure relief budgets against.
        self._memory_estimates.setdefault(slug, model_config.memory_size_mb or 0)
        try:
            return await super().get(slug)
        finally:
            self._pending_configs.pop(slug, None)

    async def get_or_load_from_ref(
        self,
        model_ref: ModelRef,
        task_type: ModelTaskType,
        db_model_config: AiModelConfig | None = None,
    ) -> LoadedModel:
        """
        Get model from cache or load it from a ModelRef.

        Handles both slug references (using db_model_config) and inline definitions.

        Args:
            model_ref: Model reference (slug or inline definition)
            task_type: Task type for the model (ASR, VAD, etc.)
            db_model_config: Model config from database (for slug references)

        Returns:
            LoadedModel
        """
        if model_ref.is_inline and model_ref.inline:
            # Inline model definition - convert to AiModelConfig
            inline_config = model_ref.inline.to_ai_model_config(task_type)
            return await self.get_or_load(inline_config)
        elif db_model_config:
            # Slug reference - use database config
            return await self.get_or_load(db_model_config)
        else:
            raise ModelLoadError(
                f"Cannot load model: slug reference '{model_ref.slug}' has no database config"
            )

    async def get_or_load_inline(
        self,
        inline_def: InlineModelDef,
        task_type: ModelTaskType,
    ) -> LoadedModel:
        """
        Get model from cache or load it from an inline definition.

        Args:
            inline_def: Inline model definition
            task_type: Task type for the model

        Returns:
            LoadedModel
        """
        model_config = inline_def.to_ai_model_config(task_type)
        return await self.get_or_load(model_config)

    async def put(self, model_slug: str, model: LoadedModel) -> None:
        """
        Put model in cache, evict if necessary.

        Args:
            model_slug: Model slug
            model: Loaded model
        """
        self._memory_estimates[model_slug] = model.memory_mb
        async with self._lock:
            victims = self._make_room_locked(model_slug)
        await self._run_unloads(victims)

        async with self._lock:
            admitted, resident, resident_bytes = self._admit_locked(model_slug, model)
        await self._run_unloads(admitted)
        self._report_load(model_slug, resident, resident_bytes)

    async def evict(self, model_slug: str) -> bool:
        """
        Evict specific model from cache.

        Args:
            model_slug: Model slug to evict

        Returns:
            True if model was evicted
        """
        return await super().evict(model_slug)

    async def clear(self) -> int:
        """
        Clear all cached models.

        Returns:
            Number of models cleared
        """
        count = await super().clear()
        logger.info(f"Cleared {count} models from cache")
        return count

    def stats(self) -> CacheStats:  # type: ignore[override]
        """Return cache statistics in stt-v2's shape."""
        models = [
            {
                "slug": slug,
                "memory_mb": entry.instance.memory_mb,
                "device": entry.instance.device,
                "format": entry.instance.format.value,
                "age_seconds": (
                    datetime.utcnow() - self._loaded_at.get(slug, datetime.utcnow())
                ).total_seconds(),
                "idle_seconds": self._time() - entry.last_accessed,
                "access_count": self._access_counts.get(slug, 0),
            }
            for slug, entry in self._entries.items()
        ]

        return CacheStats(
            total_models=len(self._entries),
            total_memory_mb=self._resident_bytes(),
            max_models=self._max_size,
            max_memory_mb=self._max_bytes_estimate or 0,
            hits=self._hits,
            misses=self._misses,
            evictions=sum(self._evictions.values()),
            models=models,
        )

    def _get_loader(self, format: AiModelFormat) -> BaseModelLoader | None:
        """Get loader for model format."""
        return self._loaders.get(format)


# Singleton instance
_cache: ModelCache | None = None


def get_model_cache() -> ModelCache:
    """Get singleton model cache instance."""
    global _cache
    if _cache is None:
        _cache = ModelCache()
    return _cache


async def clear_model_cache() -> int:
    """Clear the global model cache."""
    cache = get_model_cache()
    return await cache.clear()


__all__ = [
    "CacheEntry",
    "CacheStats",
    "ModelCache",
    "clamp_cache_ttl_seconds",
    "clear_model_cache",
    "get_model_cache",
    "set_retention_refresher",
]
