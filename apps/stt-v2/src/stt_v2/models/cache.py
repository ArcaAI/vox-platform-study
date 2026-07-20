"""Model cache with LRU eviction and TTL support."""

import asyncio
import logging
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from ..core.config.settings import get_settings
from ..core.exceptions import ModelLoadError
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


# Product policy: idle TTL ∈ [60s, 3600s].
_TTL_MIN_SECONDS = 60
_TTL_MAX_SECONDS = 3600


# TASK-525 — control-plane retention refresher, installed at app startup so the
# cache never hard-depends on HTTP (see `ModelCache._refresh_retention`).
_retention_refresher: Callable[[], Awaitable[None]] | None = None


def set_retention_refresher(refresher: Callable[[], Awaitable[None]] | None) -> None:
    """Install (or clear, with None) the control-plane retention refresher."""
    global _retention_refresher
    _retention_refresher = refresher


def clamp_cache_ttl_seconds(ttl_seconds: int) -> int:
    """Clamp idle TTL to the product window [60, 3600]."""
    return max(_TTL_MIN_SECONDS, min(_TTL_MAX_SECONDS, int(ttl_seconds)))


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


class ModelCache:
    """LRU cache with TTL for loaded models."""

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
        self._max_memory_mb = max_memory_mb or 10000  # Default 10GB
        self._max_models = max_models or settings.model_cache_max_models
        raw_ttl = ttl_seconds if ttl_seconds is not None else settings.model_cache_ttl_seconds
        self._ttl_seconds = clamp_cache_ttl_seconds(raw_ttl)

        # LRU cache (ordered dict maintains insertion order)
        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()
        self._lock = asyncio.Lock()
        # Slug → pin refcount (may outlive a brief cache miss during reload).
        self._pins: dict[str, int] = {}

        # TASK-351 P0-3 (H1) — single-flight: slug → future of the load in
        # progress. Concurrent get_or_load callers for the same slug await
        # the same future instead of each loading their own copy.
        self._inflight: dict[str, asyncio.Future[LoadedModel]] = {}

        # Statistics
        self._hits = 0
        self._misses = 0
        self._evictions = 0

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
            f"ModelCache initialized: max_models={self._max_models}, "
            f"max_memory_mb={self._max_memory_mb}, ttl_seconds={self._ttl_seconds}"
        )

    def apply_retention(self, retention: dict[str, int]) -> None:
        """TASK-525 — adopt control-plane retention values.

        Every read site consults `self._X` rather than a captured local, so a
        reassignment here takes effect on the next eviction pass without
        rebuilding the cache or disturbing resident models.

        An ABSENT key keeps the current (env/bootstrap) value — so a gateway
        outage leaves behaviour byte-identical to today. The product clamp
        [60, 3600] is re-applied here as well as server-side: a bad DB value must
        not be able to push the cache outside its supported window.
        """
        ttl_seconds = retention.get("ttl_seconds")
        if ttl_seconds is not None:
            self._ttl_seconds = clamp_cache_ttl_seconds(ttl_seconds)

        max_models = retention.get("max_models")
        if max_models is not None and max_models > 0:
            self._max_models = max_models

        max_memory_mb = retention.get("max_memory_mb")
        if max_memory_mb is not None and max_memory_mb > 0:
            self._max_memory_mb = max_memory_mb

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

    async def get(self, model_slug: str) -> LoadedModel | None:
        """
        Get model from cache, update LRU order.

        Args:
            model_slug: Model slug

        Returns:
            LoadedModel if cached, None otherwise
        """
        async with self._lock:
            return await self._get_locked(model_slug)

    async def _get_locked(self, model_slug: str) -> LoadedModel | None:
        """Cache lookup body. Caller MUST hold `self._lock`."""
        if model_slug not in self._cache:
            self._misses += 1
            return None

        entry = self._cache[model_slug]
        pin_count = self._pins.get(model_slug, 0)
        entry.pin_count = pin_count

        # Idle TTL only after last pin release; pinned models stay.
        if pin_count == 0 and entry.idle_seconds > self._ttl_seconds:
            logger.info(
                f"Model {model_slug} idle-expired "
                f"(idle={entry.idle_seconds:.0f}s, ttl={self._ttl_seconds}s)"
            )
            await self._evict_entry(model_slug)
            self._misses += 1
            return None

        # Update LRU order (move to end)
        self._cache.move_to_end(model_slug)

        # Update access stats
        entry.last_accessed = datetime.utcnow()
        entry.access_count += 1
        self._hits += 1

        logger.debug(f"Cache hit for model {model_slug}")
        return entry.model

    async def get_or_load(self, model_config: AiModelConfig) -> LoadedModel:
        """
        Get model from cache or load it — single-flight per slug
        (TASK-351 P0-3 / H1).

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

        async with self._lock:
            cached = await self._get_locked(slug)
            if cached is not None:
                return cached

            existing = self._inflight.get(slug)
            if existing is None:
                future: asyncio.Future[LoadedModel] = asyncio.get_running_loop().create_future()
                self._inflight[slug] = future
                is_owner = True
            else:
                future = existing
                is_owner = False

        if not is_owner:
            # Shield so one waiter's cancellation cannot cancel the shared load.
            return await asyncio.shield(future)

        try:
            loader = self._get_loader(model_config.format)
            if loader is None:
                raise ModelLoadError(f"No loader available for format: {model_config.format}")

            logger.info(f"Loading model {slug} (format={model_config.format})")
            model = await loader.load(model_config)

            # Cache the loaded model
            await self.put(slug, model)
        except BaseException as exc:
            if not future.done():
                future.set_exception(exc)
                # Mark the exception as retrieved so the event loop does not
                # log "exception was never retrieved" when no waiter exists.
                future.exception()
            raise
        else:
            if not future.done():
                future.set_result(model)
            return model
        finally:
            async with self._lock:
                self._inflight.pop(slug, None)

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
        async with self._lock:
            # Evict to make room if needed
            await self._evict_if_needed(model.memory_mb)

            # Add to cache
            self._cache[model_slug] = CacheEntry(
                model=model,
                loaded_at=datetime.utcnow(),
                last_accessed=datetime.utcnow(),
                access_count=1,
            )

            logger.info(
                f"Cached model {model_slug} (memory={model.memory_mb}MB, "
                f"total_cached={len(self._cache)})"
            )

    async def pin(self, model_slug: str) -> None:
        """Increment pin refcount so TTL/LRU cannot evict ``model_slug``."""
        async with self._lock:
            self._pins[model_slug] = self._pins.get(model_slug, 0) + 1
            if model_slug in self._cache:
                self._cache[model_slug].pin_count = self._pins[model_slug]
            logger.debug(f"Pinned model {model_slug} (pins={self._pins[model_slug]})")

    async def unpin(self, model_slug: str) -> None:
        """Decrement pin refcount; idle TTL applies after the last release."""
        async with self._lock:
            current = self._pins.get(model_slug, 0)
            if current <= 1:
                self._pins.pop(model_slug, None)
                new_count = 0
            else:
                new_count = current - 1
                self._pins[model_slug] = new_count
            if model_slug in self._cache:
                entry = self._cache[model_slug]
                entry.pin_count = new_count
                # Refresh idle clock when the last pin drops so TTL starts now.
                if new_count == 0:
                    entry.last_accessed = datetime.utcnow()
            logger.debug(f"Unpinned model {model_slug} (pins={new_count})")

    async def pin_many(self, model_slugs: list[str]) -> None:
        """Pin every slug in ``model_slugs`` (pipeline use)."""
        for slug in model_slugs:
            if slug:
                await self.pin(slug)

    async def unpin_many(self, model_slugs: list[str]) -> None:
        """Unpin every slug in ``model_slugs`` (session/job end)."""
        for slug in model_slugs:
            if slug:
                await self.unpin(slug)

    async def evict(self, model_slug: str) -> bool:
        """
        Evict specific model from cache.

        Args:
            model_slug: Model slug to evict

        Returns:
            True if model was evicted
        """
        async with self._lock:
            if self._pins.get(model_slug, 0) > 0:
                logger.info(f"Refusing to evict pinned model {model_slug}")
                return False
            return await self._evict_entry(model_slug)

    async def clear(self) -> int:
        """
        Clear all cached models.

        Returns:
            Number of models cleared
        """
        async with self._lock:
            count = len(self._cache)

            for slug in list(self._cache.keys()):
                await self._evict_entry(slug)

            logger.info(f"Cleared {count} models from cache")
            return count

    def stats(self) -> CacheStats:
        """Return cache statistics."""
        total_memory = sum(e.model.memory_mb for e in self._cache.values())

        models = [
            {
                "slug": slug,
                "memory_mb": entry.model.memory_mb,
                "device": entry.model.device,
                "format": entry.model.format.value,
                "age_seconds": entry.age_seconds,
                "idle_seconds": entry.idle_seconds,
                "access_count": entry.access_count,
            }
            for slug, entry in self._cache.items()
        ]

        return CacheStats(
            total_models=len(self._cache),
            total_memory_mb=total_memory,
            max_models=self._max_models,
            max_memory_mb=self._max_memory_mb,
            hits=self._hits,
            misses=self._misses,
            evictions=self._evictions,
            models=models,
        )

    def _get_loader(self, format: AiModelFormat) -> BaseModelLoader | None:
        """Get loader for model format."""
        return self._loaders.get(format)

    async def _evict_if_needed(self, required_memory_mb: int = 0) -> None:
        """
        Evict oldest/expired entries to make room.

        Args:
            required_memory_mb: Memory needed for new model
        """
        # Check model count limit (never evict pinned)
        while len(self._cache) >= self._max_models:
            if not await self._evict_oldest():
                break

        # Check memory limit
        current_memory = sum(e.model.memory_mb for e in self._cache.values())
        while current_memory + required_memory_mb > self._max_memory_mb and self._cache:
            evicted = await self._evict_oldest()
            if evicted:
                current_memory = sum(e.model.memory_mb for e in self._cache.values())
            else:
                break

        # Evict idle-expired unpinned entries
        expired = [
            slug
            for slug, entry in self._cache.items()
            if self._pins.get(slug, 0) == 0 and entry.idle_seconds > self._ttl_seconds
        ]
        for slug in expired:
            await self._evict_entry(slug)

    async def _evict_oldest(self) -> bool:
        """Evict oldest unpinned (least recently used) entry."""
        if not self._cache:
            return False

        for slug in list(self._cache.keys()):
            if self._pins.get(slug, 0) > 0:
                continue
            return await self._evict_entry(slug)
        logger.warning("Cannot LRU-evict: all cached models are pinned")
        return False

    async def _evict_entry(self, model_slug: str) -> bool:
        """Evict specific entry and unload model. Caller must not pass pinned slugs."""
        if model_slug not in self._cache:
            return False
        if self._pins.get(model_slug, 0) > 0:
            return False

        entry = self._cache.pop(model_slug)
        self._evictions += 1

        # Get loader and unload
        loader = self._get_loader(entry.model.format)
        if loader:
            try:
                await loader.unload(entry.model)
            except Exception as e:
                logger.warning(f"Error unloading model {model_slug}: {e}")

        logger.info(
            f"Evicted model {model_slug} (memory={entry.model.memory_mb}MB, "
            f"idle={entry.idle_seconds:.0f}s)"
        )
        return True


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
