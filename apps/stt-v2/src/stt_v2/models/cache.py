"""Model cache with LRU eviction and TTL support."""

import asyncio
import logging
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from ..core.config.settings import get_settings
from ..core.exceptions import ModelLoadError
from ..pipeline.dto import AiModelConfig, AiModelFormat, InlineModelDef, ModelRef, ModelTaskType
from .azure_speech_loader import AzureSpeechLoader
from .base_loader import BaseModelLoader, LoadedModel
from .huggingface_loader import HuggingFaceLoader
from .nemo_loader import NeMoLoader
from .onnx_loader import ONNXLoader

logger = logging.getLogger(__name__)


@dataclass
class CacheEntry:
    """Cache entry with metadata."""

    model: LoadedModel
    loaded_at: datetime
    last_accessed: datetime
    access_count: int = 0

    @property
    def age_seconds(self) -> float:
        """Get age of cache entry in seconds."""
        return (datetime.utcnow() - self.loaded_at).total_seconds()

    @property
    def idle_seconds(self) -> float:
        """Get time since last access in seconds."""
        return (datetime.utcnow() - self.last_accessed).total_seconds()


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

        self._max_memory_mb = max_memory_mb or 10000  # Default 10GB
        self._max_models = max_models or settings.model_cache_max_models
        self._ttl_seconds = ttl_seconds or settings.model_cache_ttl_seconds

        # LRU cache (ordered dict maintains insertion order)
        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()
        self._lock = asyncio.Lock()

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
            AiModelFormat.CTRANSLATE2: HuggingFaceLoader(),  # CTranslate2 handled by HuggingFace loader for now
            AiModelFormat.AZURE_SPEECH: AzureSpeechLoader(),  # Cloud-based Azure Cognitive Services
        }

        logger.info(
            f"ModelCache initialized: max_models={self._max_models}, "
            f"max_memory_mb={self._max_memory_mb}, ttl_seconds={self._ttl_seconds}"
        )

    async def get(self, model_slug: str) -> LoadedModel | None:
        """
        Get model from cache, update LRU order.

        Args:
            model_slug: Model slug

        Returns:
            LoadedModel if cached, None otherwise
        """
        async with self._lock:
            if model_slug not in self._cache:
                self._misses += 1
                return None

            entry = self._cache[model_slug]

            # Check TTL
            if entry.age_seconds > self._ttl_seconds:
                logger.info(f"Model {model_slug} expired (age={entry.age_seconds:.0f}s)")
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
        Get model from cache or load it.

        Args:
            model_config: Model configuration

        Returns:
            LoadedModel
        """
        # Try cache first
        cached = await self.get(model_config.slug)
        if cached is not None:
            return cached

        # Load model
        loader = self._get_loader(model_config.format)
        if loader is None:
            raise ModelLoadError(f"No loader available for format: {model_config.format}")

        logger.info(f"Loading model {model_config.slug} (format={model_config.format})")
        model = await loader.load(model_config)

        # Cache the loaded model
        await self.put(model_config.slug, model)

        return model

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

    async def evict(self, model_slug: str) -> bool:
        """
        Evict specific model from cache.

        Args:
            model_slug: Model slug to evict

        Returns:
            True if model was evicted
        """
        async with self._lock:
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
        # Check model count limit
        while len(self._cache) >= self._max_models:
            await self._evict_oldest()

        # Check memory limit
        current_memory = sum(e.model.memory_mb for e in self._cache.values())
        while current_memory + required_memory_mb > self._max_memory_mb and self._cache:
            evicted = await self._evict_oldest()
            if evicted:
                current_memory = sum(e.model.memory_mb for e in self._cache.values())
            else:
                break

        # Evict expired entries
        expired = [
            slug for slug, entry in self._cache.items() if entry.age_seconds > self._ttl_seconds
        ]
        for slug in expired:
            await self._evict_entry(slug)

    async def _evict_oldest(self) -> bool:
        """Evict oldest (least recently used) entry."""
        if not self._cache:
            return False

        # Get oldest entry (first in OrderedDict)
        oldest_slug = next(iter(self._cache))
        return await self._evict_entry(oldest_slug)

    async def _evict_entry(self, model_slug: str) -> bool:
        """Evict specific entry and unload model."""
        if model_slug not in self._cache:
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
            f"age={entry.age_seconds:.0f}s)"
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
