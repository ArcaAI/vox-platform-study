"""Model cache with LRU eviction and TTL support.

The retention POLICY (single-flight load,
idle TTL clamped to [60s, 3600s], pin/unpin refcounting, LRU bound, memory
budget, periodic sweep, VRAM-aware eviction, unload-on-every-eviction-path) now
lives in the shared contract `hope_runtime_models.ModelCache`, which every HOPE
service composes. See `packages/py-runtime-models/README.md`.

This module is the stt-facing surface of that contract. It keeps EVERY public
spelling stt callers and tests already use — `get()` as a peek, `put()`,
`get_or_load*()`, the stt `CacheEntry`/`CacheStats` shapes, `_loaders`,
`apply_retention` — and nothing else: the ~150-line local copy of the policy is
gone. This refactor was deliberately deferred earlier (567 lines on the ASR hot
path); the parity gate for it is
`tests/unit/test_model_cache.py` + `test_model_cache_ttl.py` passing UNMODIFIED.

Two spellings differ from the shared contract on purpose, because stt's API
predates it and its callers depend on them:

* ``get(slug)`` is a PEEK returning ``LoadedModel | None`` — it never loads.
  The contract's get-or-load path is ``get_or_load(config)``, which is what
  delegates to the shared single-flight machinery.
* entries are surfaced through ``_cache`` as `CacheEntry` objects carrying
  ``datetime`` timestamps; the shared core stores monotonic floats. `_cache` is
  a live view that converts in both directions, so mutating an entry through it
  still steers the policy.
"""

import dataclasses
import logging
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from hope_runtime_models import Device, clamp_cache_ttl_seconds, torch_module_bytes
from hope_runtime_models import ModelCache as SharedModelCache
from hope_runtime_models.residency_agent import DeviceUnavailable

from ..core.config.settings import get_settings
from ..core.exceptions import ModelLoadError, ModelNotCacheServedError
from ..core.metrics import build_model_cache_metrics_sink
from ..pipeline.dto import AiModelConfig, AiModelFormat, InlineModelDef, ModelRef, ModelTaskType
from ..residency import wiring as residency_wiring
from .azure_foundry_loader import AzureFoundryLoader
from .azure_speech_loader import AzureSpeechLoader
from .base_loader import BaseModelLoader, LoadedModel
from .faster_whisper_loader import FasterWhisperLoader
from .huggingface_loader import HuggingFaceLoader
from .nemo_loader import NeMoLoader
from .onnx_loader import ONNXLoader
from .openai_loader import OpenAILoader
from .parakeet_cpp_loader import ParakeetCppLoader
from .sarvam_loader import SarvamLoader
from .vllm_loader import VllmLoader
from .whisper_cpp_loader import WhisperCppLoader

logger = logging.getLogger(__name__)


# Control-plane retention refresher, installed at app startup so the
# cache never hard-depends on HTTP (see `ModelCache._refresh_retention`).
_retention_refresher: Callable[[], Awaitable[None]] | None = None


#: TASK-944 (B2) — serving libraries (`AiModel.libraryName`) whose weights are
#: owned by a DEDICATED runtime inside this process, not by this model cache.
#: The value NAMES that runtime, because a refusal that does not say who loads
#: the model instead is what sends the next reader back to the data.
#:
#: Every entry is a `format = PYTORCH` (or SAFETENSOR) row that the pre-TASK-860
#: format-keyed registry handed to `HuggingFaceLoader`, i.e. to `transformers`.
#: None of them is a transformers checkpoint: the pyannote snapshot publishes
#: `config.yaml` + `pytorch_model.bin` and no `config.json`, the speechbrain one
#: publishes `hyperparams.yaml`, and the two denoisers have no published weights
#: at all (they ship inside their wheels — `sourceUri` is `pypi:` / `github:`).
#: Warming one of these through the cache was never a load that could succeed:
#: it was ~9.3 s of a doomed transformers resolution on every cold session, and
#: it never gated the feature — the session manager builds the embedding service
#: and the denoisers itself, from the very same `ResolvedAsrSpec` rows.
RUNTIME_OWNED_LIBRARIES: dict[str, str] = {
    "pyannote-audio": (
        "stt.diarization.pyannote_embedding.PyannoteEmbeddingService "
        "(pyannote.audio Model.from_pretrained reads config.yaml; transformers cannot)"
    ),
    "speechbrain": (
        "stt.diarization.speechbrain_embedding.SpeechBrainEmbeddingService "
        "(speechbrain reads hyperparams.yaml; transformers cannot)"
    ),
    "pyrnnoise": (
        "the RNNoise denoiser — its coefficients are compiled into the `pyrnnoise` "
        "wheel, so there are no published weights to cache"
    ),
    "deepfilternet": (
        "stt.streaming.deepfilternet_denoiser — `df.enhance.init_df` reads the "
        "DeepFilterNet3 checkpoint from the row's bucket directory (`local_path`) itself"
    ),
    "cadence-punctuation": (
        "the punctuation service, which loads its own model; `models.punctuation` "
        "is referenced by slug only and never enters this cache"
    ),
}

#: TASK-977 — the denoise ENGINE (`DenoiseConfig.engine`) each runtime-owned denoise
#: library selects. Both engines ship inside their wheels and are chosen by NAME, so an
#: agent's bound denoise row chooses one only through its declared library. Every key is
#: also a `RUNTIME_OWNED_LIBRARIES` key. A library absent here names no denoise engine,
#: and `pipeline_spec_from_resolved` refuses it — it never runs RNNoise in its place.
DENOISE_ENGINE_BY_LIBRARY: dict[str, str] = {
    "pyrnnoise": "rnnoise",
    "deepfilternet": "deepfilternet3",
}


#: TASK-1055 — artifact formats whose `LoadedModel.model` is a torch module, so a load
#: is sized by its parameter + buffer bytes (deterministic, blind to card-mates on a
#: time-sliced GPU). Every other format — CTranslate2 (faster-whisper), ggml
#: (whisper.cpp / parakeet.cpp), ONNX, the remote/cloud engines — keeps the device
#: free-memory delta, because nothing in the process can count its bytes.
TORCH_MODULE_FORMATS: frozenset[AiModelFormat] = frozenset(
    {
        AiModelFormat.SAFETENSOR,
        AiModelFormat.PYTORCH,
        AiModelFormat.CTRANSLATE2,  # legacy alias, loaded by transformers
        AiModelFormat.NEMO,
    }
)


def measure_loaded_model(instance: LoadedModel) -> int | None:
    """The `ModelCache(measure=...)` hook: torch parameter bytes, else None (= delta)."""
    if instance.format not in TORCH_MODULE_FORMATS:
        return None
    return torch_module_bytes(instance.model)


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
    """LRU cache with TTL for loaded models — stt's skin on the shared policy.

    NOTE the deliberate spelling difference from the shared contract: ``get`` is
    stt's long-standing PEEK (returns None on a miss, never loads) and
    ``get_or_load`` is the loading path. Nothing inside the shared core calls
    ``self.get``, so the override is contained to this class's public API.
    """

    def __init__(
        self,
        max_memory_mb: int | None = None,
        max_models: int | None = None,
        ttl_seconds: int | None = None,
        *,
        device: Device | None = None,
    ):
        """
        Initialize model cache.

        Args:
            max_memory_mb: Maximum memory for cached models
            max_models: Maximum number of models
            ttl_seconds: TTL for cached models
            device: TASK-1055 — the GPU this cache is BOUND to. ``None`` = the
                process's default device, with today's placement (each loader's
                own default). A bound cache loads every model ON its device.
        """
        settings = get_settings()

        # These three are BOOTSTRAP FALLBACKS; their runtime values
        # come from the control plane via `apply_retention` below. Note
        # `max_memory_mb` has no settings field at all — this literal is the only
        # default it has ever had, and the registry descriptor deliberately
        # mirrors it rather than the divergent seed row.
        raw_ttl = ttl_seconds if ttl_seconds is not None else settings.model_cache_ttl_seconds

        # Per-slug side tables the shared core does not model: stt surfaces
        # `loaded_at` / `access_count` in `/internal/cache/stats`, and the memory
        # budget is expressed in MB rather than bytes.
        self._loaded_at: dict[str, datetime] = {}
        self._access_counts: dict[str, int] = {}
        self._memory_estimates: dict[str, int] = {}
        # Slug → the config of a load in flight (the shared factory is keyed by
        # slug alone and cannot reconstruct one).
        self._pending_configs: dict[str, AiModelConfig] = {}
        # TASK-1055 — the device stamped onto every config this cache loads (bound
        # caches only), and the session pins this DEFAULT cache forwarded to the
        # device cache that actually holds the model (see `pin`).
        self._placement: str | None = None if device is None else device.id
        self._routed_pins: dict[str, list[ModelCache]] = {}

        super().__init__(
            factory=self._load_by_slug,
            unload=self._unload_model,
            ttl_seconds=raw_ttl,
            max_size=max_models or settings.model_cache_max_models,
            max_bytes_estimate=max_memory_mb or 10000,  # Default 10GB
            estimate_bytes=self._memory_estimates.get,  # type: ignore[arg-type]
            metrics=build_model_cache_metrics_sink(),
            # One cache per device (TASK-1055): a distinct name keeps the
            # per-cache gauges of two devices from overwriting each other.
            name="stt_model_cache" if device is None else f"stt_model_cache@{device.id}",
            # TASK-1005 — measured footprints + residency metrics, in the API AND
            # the Dramatiq worker (both build this cache). Admission stays off.
            residency=residency_wiring.stt_cache_residency(device),
            # TASK-1055 — torch models are sized by their parameters (see
            # `measure_loaded_model`); the rest keep the device delta.
            measure=measure_loaded_model,
        )

        self._cache = _CacheEntryView(self)

        # Model loaders - map format/engine to appropriate loader.
        # Extracted to `_install_loaders` so the registry has exactly ONE
        # construction site, which the BYOK lock test
        # (`tests/unit/test_task799_byok_credentials.py`) reads directly rather
        # than rebuilding — a second copy would be one more hand-written list to
        # drift, which is the defect that suite exists to prevent.
        self._install_loaders()

        logger.info(
            f"ModelCache initialized: max_models={self._max_size}, "
            f"max_memory_mb={self._max_bytes_estimate}, ttl_seconds={self._ttl_seconds}"
        )

    def _install_loaders(self) -> None:
        """Build the loader registry — BOTH keys, one set of loader instances.

        The single source of truth for which engines this service can run. Every
        loader declares its `credential_posture`; the lock test iterates BOTH maps
        so a new engine cannot be added without stating whether it needs a vendor
        credential.

        `_library_loaders` is the SELECTION key (TASK-944 B2 / TASK-860):
        `AiModel.libraryName` says which library serves a row, and `format` has
        been descriptive since TASK-860. `_loaders` — the pre-TASK-860 format map
        — survives as the fallback for the paths that declare no library (inline
        model definitions, the deprecated DB reader, a spec from a gateway that
        predates the wire field) and as the key `_unload_model` releases by, since
        a `LoadedModel` carries a format and not a library.

        The two maps share loader INSTANCES on purpose: a model admitted through
        the library key must be released through the very same loader.
        """
        huggingface = HuggingFaceLoader()
        onnx = ONNXLoader()
        nemo = NeMoLoader()
        faster_whisper = FasterWhisperLoader()
        azure_speech = AzureSpeechLoader()
        azure_foundry = AzureFoundryLoader()
        parakeet_cpp = ParakeetCppLoader()
        whisper_cpp = WhisperCppLoader()
        sarvam = SarvamLoader()
        openai = OpenAILoader()
        vllm = VllmLoader()

        self._loaders: dict[AiModelFormat, BaseModelLoader] = {
            AiModelFormat.SAFETENSOR: huggingface,
            AiModelFormat.PYTORCH: huggingface,
            AiModelFormat.ONNX: onnx,
            AiModelFormat.ONNX_OPTIMUM: onnx,  # HuggingFace Optimum ONNX uses same loader
            AiModelFormat.NEMO: nemo,
            AiModelFormat.CTRANSLATE2: huggingface,  # Legacy alias — transformers path
            # faster-whisper on CTranslate2 (lazy import)
            AiModelFormat.FASTER_WHISPER: faster_whisper,
            AiModelFormat.AZURE_SPEECH: azure_speech,  # Cloud Azure Cognitive Services
            # New engines (both lazy at load time).
            AiModelFormat.AZURE_FOUNDRY: azure_foundry,
            AiModelFormat.PARAKEET_CPP: parakeet_cpp,
            # whisper.cpp (lazy at load time).
            AiModelFormat.WHISPER_CPP: whisper_cpp,
            # Cloud BYOK speech engines (REST).
            AiModelFormat.SARVAM: sarvam,
            AiModelFormat.OPENAI: openai,
            # TASK-1021 — Whisper on the in-cluster `vllm` service (REST, no weights).
            AiModelFormat.VLLM: vllm,
        }

        # Keys are `AiModel.libraryName` values, validated platform-side against
        # `AI_MODEL_LIBRARIES` (packages/applications `services/ai-model/constants.ts`).
        # Every library an `stt`-served row may declare appears HERE or in
        # `RUNTIME_OWNED_LIBRARIES`; anything else fails closed.
        self._library_loaders: dict[str, BaseModelLoader] = {
            "transformers": huggingface,
            "ctranslate2": huggingface,  # legacy alias — transformers path
            "faster-whisper": faster_whisper,
            "whisper.cpp": whisper_cpp,
            "parakeet.cpp": parakeet_cpp,
            "nemo": nemo,
            "onnxruntime": onnx,
            "azure-speech": azure_speech,
            "azure-foundry": azure_foundry,
            "sarvam": sarvam,
            "openai": openai,
            "vllm": vllm,
        }

    # ── legacy internal spellings ───────────────────────────────────────────
    # The shared core calls these `_max_size` / `_max_bytes_estimate`. stt's
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
        loader = self.loader_for(model_config)

        logger.info(
            "Loading model %s (library=%s, format=%s, loader=%s)",
            slug,
            model_config.library_name or "<undeclared>",
            model_config.format,
            type(loader).__name__,
        )
        return await loader.load(model_config)

    async def _unload_model(self, slug: str, model: LoadedModel) -> None:
        """Release an evicted model through its format's loader."""
        loader = self._get_loader(model.format)
        if loader is not None:
            await loader.unload(model)
        logger.info(f"Evicted model {slug} (memory={model.memory_mb}MB)")

    # ── control-plane retention ─────────────────────────────────────────────

    def apply_retention(self, retention: dict[str, int]) -> None:
        """Adopt control-plane retention values.

        An ABSENT key keeps the current (env/bootstrap) value — so a gateway
        outage leaves behaviour byte-identical to today. Resident models are
        never dropped: new limits take effect on the next eviction pass. The
        product clamp [60, 3600] is re-applied inside the shared cache as well
        as server-side — a bad DB value must not be able to push the cache
        outside its supported window.
        """
        for cache in (self, *self._siblings()):
            cache.configure(
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

    # ── the stt public surface ───────────────────────────────────────────

    async def get(self, model_slug: str) -> LoadedModel | None:  # type: ignore[override]
        """Peek the cache and update LRU order — NEVER loads (see class docstring).

        Args:
            model_slug: Model slug

        Returns:
            LoadedModel if cached, None otherwise
        """
        elsewhere = self._resident_elsewhere(model_slug)
        if elsewhere is not None:
            return await elsewhere.get(model_slug)
        async with self._lock:
            hit, victims = self._lookup_locked(model_slug)
        await self._run_unloads(victims)
        return hit

    async def get_or_load(self, model_config: AiModelConfig) -> LoadedModel:
        """
        Get model from cache or load it — single-flight per slug
        (now the shared contract's single-flight).

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

        # Read-triggered control-plane refresh. Cached inside the
        # client's TTL window (so this is ~free), never raises, and runs BEFORE
        # the eviction pass below so a freshly-served retention value applies to
        # this load rather than the next one.
        await self._refresh_retention()

        # TASK-1055 — a model resident ONLY on another device is served from there
        # (no second copy on the default GPU); everything else loads here.
        elsewhere = self._resident_elsewhere(slug)
        if elsewhere is not None:
            return await elsewhere.get_or_load(model_config)
        model_config = self._placed(model_config)

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

    # ── per-device placement (TASK-1055) ────────────────────────────────────

    def _siblings(self) -> list["ModelCache"]:
        """The other device caches — only the process's DEFAULT cache routes to them."""
        if self is not _cache:
            return []
        return [cache for cache in _device_caches.values() if cache is not self]

    def _resident_elsewhere(self, slug: str) -> "ModelCache | None":
        """The device cache holding ``slug`` when THIS (default) cache neither holds
        nor is loading it — the only case session traffic leaves the default GPU."""
        if slug in self._entries or slug in self._inflight:
            return None
        for sibling in self._siblings():
            if slug in sibling._entries:
                return sibling
        return None

    def _placed(self, model_config: AiModelConfig) -> AiModelConfig:
        """The config a BOUND cache loads: its device stamped on, whatever the row said."""
        if self._placement is None or model_config.device == self._placement:
            return model_config
        loader = self.loader_for(model_config)
        if getattr(loader, "places_on_device_index", False) is not True:
            raise ModelLoadError(
                f"Model '{model_config.slug}' is served by {type(loader).__name__}, which "
                f"cannot be placed on {self._placement}"
            )
        return dataclasses.replace(model_config, device=self._placement)

    async def pin(self, key: str) -> None:
        """Pin ``key`` on the cache whose copy the caller is using (TASK-1055).

        Session traffic always goes through the default cache; when the model is
        resident only on another device, the pin goes there, so a live session
        protects the copy it is decoding with (and the report shows it in flight).
        """
        elsewhere = self._resident_elsewhere(key)
        if elsewhere is not None:
            self._routed_pins.setdefault(key, []).append(elsewhere)
            await elsewhere.pin(key)
            return
        await super().pin(key)

    async def unpin(self, key: str) -> None:
        routed = self._routed_pins.get(key)
        if routed:
            target = routed.pop()
            if not routed:
                del self._routed_pins[key]
            await target.unpin(key)
            return
        await super().unpin(key)

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
        """Return cache statistics in stt's shape."""
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
        """Get loader for model format.

        The pre-TASK-860 key. Still the release path (`_unload_model` has only a
        `LoadedModel`, which carries a format and no library) and still the
        fallback for a config that declares no library. `loader_for` is what a
        LOAD goes through.
        """
        return self._loaders.get(format)

    def loader_for(self, model_config: AiModelConfig) -> BaseModelLoader:
        """The loader that executes this row — selected by its DECLARED library.

        `AiModel.libraryName` is the loader-selection field ("Artifact format —
        descriptive only since TASK-860. Loader selection is `libraryName`",
        `packages/database/src/prisma/db_main/ai-model.prisma`). This runtime
        never received it, so it kept keying on `format` — and `PYTORCH` is worn
        by a pyannote embedder, a speechbrain embedder and two denoisers as well
        as by real transformers checkpoints, so the key could not tell them
        apart and sent all four to `transformers`.

        Selection FAILS CLOSED, per `.claude/rules/09-infrastructure-devops.md`:
        a library this service does not serve raises, and no engine is guessed
        in its place. The `format` fallback applies ONLY when no library is
        declared at all — an inline model definition, the deprecated DB reader,
        or a spec from a gateway that predates the wire field.
        """
        library = (model_config.library_name or "").strip()
        if library:
            owner = RUNTIME_OWNED_LIBRARIES.get(library)
            if owner is not None:
                raise ModelNotCacheServedError(
                    f"Model '{model_config.slug}' declares serving library '{library}', which "
                    f"this model cache does not load. It is executed by {owner}. This is a "
                    "LOADER-SELECTION outcome, not a missing or mislocated model: do not go "
                    "looking for the weights."
                )
            loader = self._library_loaders.get(library)
            if loader is None:
                raise ModelLoadError(
                    f"Model '{model_config.slug}' declares serving library '{library}', which "
                    "the STT runtime has no loader for. Known libraries: "
                    f"{sorted(self._library_loaders)}; runtime-owned: "
                    f"{sorted(RUNTIME_OWNED_LIBRARIES)}."
                )
            return loader

        loader = self._get_loader(model_config.format)
        if loader is None:
            raise ModelLoadError(f"No loader available for format: {model_config.format}")
        return loader


# Singleton instance (the default device's cache) + one lazily-built cache per
# other device (TASK-1055), keyed by device id.
_cache: ModelCache | None = None
_device_caches: dict[str, ModelCache] = {}


def get_model_cache(device: str | None = None) -> ModelCache:
    """The model cache for ``device`` (``cuda:<i>``); ``None`` = the default device's.

    A non-default device's cache is created on first use with the default cache's
    CURRENT retention (TTL, model count, memory budget) and the same metrics, and
    follows every later `apply_retention`. Raises `DeviceUnavailable` for a device
    this process does not see.
    """
    global _cache
    if _cache is None:
        _cache = ModelCache()
    default = _cache
    if device is None or default.residency is None or device == default.residency.device.id:
        return default
    cache = _device_caches.get(device)
    if cache is None:
        target = residency_wiring.stt_device_by_id(device)
        if target is None:
            raise DeviceUnavailable(f"{residency_wiring.SERVICE} sees no device {device}")
        cache = ModelCache(device=target)
        cache.configure(
            ttl_seconds=default._ttl_seconds,
            max_size=default._max_size,
            max_bytes_estimate=default._max_bytes_estimate,
        )
        _device_caches[device] = cache
    return cache


def device_model_caches() -> list[ModelCache]:
    """Every model cache in this process: the default one first, then per device."""
    default = get_model_cache()
    return [default, *(cache for cache in _device_caches.values() if cache is not default)]


async def clear_model_cache() -> int:
    """Clear every model cache in the process (the default one and each device's)."""
    cleared = 0
    for cache in device_model_caches():
        cleared += await cache.clear()
    return cleared


__all__ = [
    "DENOISE_ENGINE_BY_LIBRARY",
    "RUNTIME_OWNED_LIBRARIES",
    "CacheEntry",
    "TORCH_MODULE_FORMATS",
    "CacheStats",
    "ModelCache",
    "clamp_cache_ttl_seconds",
    "clear_model_cache",
    "device_model_caches",
    "get_model_cache",
    "measure_loaded_model",
    "set_retention_refresher",
]
