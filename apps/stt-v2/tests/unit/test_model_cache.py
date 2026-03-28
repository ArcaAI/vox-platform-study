"""Unit tests for Model Cache."""

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt_v2.models.base_loader import LoadedModel
from stt_v2.models.cache import (
    CacheEntry,
    CacheStats,
    ModelCache,
)
from stt_v2.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    InlineModelDef,
    ModelRef,
    ModelTaskType,
)


class TestCacheEntry:
    """Tests for CacheEntry dataclass."""

    @pytest.fixture
    def sample_loaded_model(self):
        """Create a sample loaded model."""
        return LoadedModel(
            model_id="m-1",
            model_slug="whisper-test",
            model=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=1000,
            device="cuda",
        )

    def test_age_seconds(self, sample_loaded_model):
        """Test age calculation."""
        entry = CacheEntry(
            model=sample_loaded_model,
            loaded_at=datetime.utcnow() - timedelta(seconds=60),
            last_accessed=datetime.utcnow(),
        )

        assert 59 <= entry.age_seconds <= 61

    def test_idle_seconds(self, sample_loaded_model):
        """Test idle time calculation."""
        entry = CacheEntry(
            model=sample_loaded_model,
            loaded_at=datetime.utcnow() - timedelta(seconds=120),
            last_accessed=datetime.utcnow() - timedelta(seconds=30),
        )

        assert 29 <= entry.idle_seconds <= 31


class TestCacheStats:
    """Tests for CacheStats dataclass."""

    def test_hit_rate_with_data(self):
        """Test hit rate calculation."""
        stats = CacheStats(
            total_models=5,
            total_memory_mb=5000,
            max_models=10,
            max_memory_mb=10000,
            hits=80,
            misses=20,
            evictions=5,
        )

        assert stats.hit_rate == 0.8

    def test_hit_rate_zero_total(self):
        """Test hit rate with zero total."""
        stats = CacheStats(
            total_models=0,
            total_memory_mb=0,
            max_models=10,
            max_memory_mb=10000,
            hits=0,
            misses=0,
            evictions=0,
        )

        assert stats.hit_rate == 0.0


class TestModelCache:
    """Tests for ModelCache."""

    @pytest.fixture
    def cache(self):
        """Create a cache with test settings."""
        return ModelCache(
            max_memory_mb=5000,
            max_models=3,
            ttl_seconds=3600,
        )

    @pytest.fixture
    def sample_loaded_model(self):
        """Create a sample loaded model."""
        return LoadedModel(
            model_id="m-1",
            model_slug="whisper-test",
            model=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=1000,
            device="cuda",
        )

    @pytest.mark.asyncio
    async def test_put_and_get(self, cache, sample_loaded_model):
        """Test putting and getting a model."""
        await cache.put("whisper-test", sample_loaded_model)

        result = await cache.get("whisper-test")

        assert result is not None
        assert result.model_slug == "whisper-test"
        assert result.memory_mb == 1000

    @pytest.mark.asyncio
    async def test_get_nonexistent(self, cache):
        """Test getting a nonexistent model."""
        result = await cache.get("nonexistent")

        assert result is None

    @pytest.mark.asyncio
    async def test_cache_miss_increments_counter(self, cache):
        """Test that cache misses are counted."""
        initial_stats = cache.stats()
        initial_misses = initial_stats.misses

        await cache.get("nonexistent")

        new_stats = cache.stats()
        assert new_stats.misses == initial_misses + 1

    @pytest.mark.asyncio
    async def test_cache_hit_increments_counter(self, cache, sample_loaded_model):
        """Test that cache hits are counted."""
        await cache.put("whisper-test", sample_loaded_model)

        initial_stats = cache.stats()
        initial_hits = initial_stats.hits

        await cache.get("whisper-test")

        new_stats = cache.stats()
        assert new_stats.hits == initial_hits + 1

    @pytest.mark.asyncio
    async def test_evict_model(self, cache, sample_loaded_model):
        """Test evicting a specific model."""
        await cache.put("whisper-test", sample_loaded_model)

        # Verify it's in cache
        assert await cache.get("whisper-test") is not None

        # Evict it
        evicted = await cache.evict("whisper-test")

        assert evicted is True
        assert await cache.get("whisper-test") is None

    @pytest.mark.asyncio
    async def test_evict_nonexistent(self, cache):
        """Test evicting a nonexistent model."""
        evicted = await cache.evict("nonexistent")

        assert evicted is False

    @pytest.mark.asyncio
    async def test_clear_cache(self, cache, sample_loaded_model):
        """Test clearing the entire cache."""
        await cache.put("model-1", sample_loaded_model)

        model2 = LoadedModel(
            model_id="m-2",
            model_slug="model-2",
            model=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=500,
            device="cpu",
        )
        await cache.put("model-2", model2)

        count = await cache.clear()

        assert count == 2
        assert await cache.get("model-1") is None
        assert await cache.get("model-2") is None

    @pytest.mark.asyncio
    async def test_lru_eviction_on_max_models(self, cache, sample_loaded_model):
        """Test LRU eviction when max models is reached."""
        # Fill cache to max (3 models)
        for i in range(3):
            model = LoadedModel(
                model_id=f"m-{i}",
                model_slug=f"model-{i}",
                model=MagicMock(),
                format=AiModelFormat.SAFETENSOR,
                memory_mb=100,
                device="cpu",
            )
            await cache.put(f"model-{i}", model)

        # Access model-1 to make it recently used
        await cache.get("model-1")

        # Add a 4th model, should evict model-0 (oldest)
        new_model = LoadedModel(
            model_id="m-new",
            model_slug="model-new",
            model=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=100,
            device="cpu",
        )
        await cache.put("model-new", new_model)

        # model-0 should be evicted (was LRU)
        assert await cache.get("model-0") is None
        # model-1 and model-2 should still be there
        assert await cache.get("model-1") is not None
        assert await cache.get("model-new") is not None

    @pytest.mark.asyncio
    async def test_ttl_expiration(self):
        """Test TTL expiration."""
        # Create cache with 1 second TTL
        cache = ModelCache(
            max_memory_mb=5000,
            max_models=10,
            ttl_seconds=1,
        )

        model = LoadedModel(
            model_id="m-1",
            model_slug="test",
            model=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=100,
            device="cpu",
            loaded_at=datetime.utcnow() - timedelta(seconds=2),  # Already expired
        )

        # Manually add to cache with old timestamp
        cache._cache["test"] = CacheEntry(
            model=model,
            loaded_at=datetime.utcnow() - timedelta(seconds=2),
            last_accessed=datetime.utcnow() - timedelta(seconds=2),
        )

        # Should return None due to TTL expiration
        result = await cache.get("test")
        assert result is None

    def test_stats(self, cache):
        """Test getting cache statistics."""
        stats = cache.stats()

        assert isinstance(stats, CacheStats)
        assert stats.max_models == 3
        assert stats.max_memory_mb == 5000
        assert stats.total_models == 0


class TestLoadedModel:
    """Tests for LoadedModel dataclass."""

    def test_repr(self):
        """Test string representation."""
        model = LoadedModel(
            model_id="m-1",
            model_slug="whisper-test",
            model=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=1000,
            device="cuda",
        )

        repr_str = repr(model)

        assert "whisper-test" in repr_str
        assert "SAFETENSOR" in repr_str
        assert "cuda" in repr_str
        assert "1000" in repr_str


class TestModelCacheInlineModels:
    """Tests for inline model loading in ModelCache."""

    @pytest.fixture
    def cache(self):
        """Create a cache with test settings."""
        return ModelCache(
            max_memory_mb=5000,
            max_models=5,
            ttl_seconds=3600,
        )

    @pytest.fixture
    def sample_inline_def(self):
        """Create a sample inline model definition."""
        return InlineModelDef(
            hf_model_id="onnx-community/whisper-large-v3-turbo",
            engine=AiModelFormat.ONNX,
            revision="main",
        )

    @pytest.fixture
    def sample_ai_model_config(self):
        """Create a sample AI model config."""
        return AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="whisper-test",
            name="Whisper Test",
            description="Test model",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="openai/whisper-tiny",
            source_revision=None,
            format=AiModelFormat.SAFETENSOR,
            memory_size_mb=80,
            compute_type="float32",
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=None,
            downloaded_at=datetime.utcnow(),
            file_size_mb=80,
            checksum=None,
            tags=[],
        )

    @pytest.mark.asyncio
    async def test_get_or_load_inline_converts_to_config(self, cache, sample_inline_def):
        """Test that get_or_load_inline converts inline def to config."""
        # Mock the loader to avoid actual model loading
        mock_loaded_model = LoadedModel(
            model_id="inline:test",
            model_slug="test-slug",
            model=MagicMock(),
            format=AiModelFormat.ONNX,
            memory_mb=100,
            device="cpu",
        )

        with patch.object(cache, 'get_or_load', new_callable=AsyncMock) as mock_get_or_load:
            mock_get_or_load.return_value = mock_loaded_model

            result = await cache.get_or_load_inline(
                sample_inline_def,
                ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            )

            # Verify the method was called
            mock_get_or_load.assert_called_once()

            # Verify the config passed to get_or_load
            call_args = mock_get_or_load.call_args[0][0]
            assert call_args.source_uri == "onnx-community/whisper-large-v3-turbo"
            assert call_args.format == AiModelFormat.ONNX
            assert call_args.task_type == ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION

            assert result == mock_loaded_model

    @pytest.mark.asyncio
    async def test_get_or_load_from_ref_with_slug(self, cache, sample_ai_model_config):
        """Test get_or_load_from_ref with slug reference."""
        mock_loaded_model = LoadedModel(
            model_id="m-1",
            model_slug="whisper-test",
            model=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=80,
            device="cpu",
        )

        slug_ref = ModelRef(slug="whisper-test")

        with patch.object(cache, 'get_or_load', new_callable=AsyncMock) as mock_get_or_load:
            mock_get_or_load.return_value = mock_loaded_model

            result = await cache.get_or_load_from_ref(
                slug_ref,
                ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
                db_model_config=sample_ai_model_config,
            )

            # Should use the db config
            mock_get_or_load.assert_called_once_with(sample_ai_model_config)
            assert result == mock_loaded_model

    @pytest.mark.asyncio
    async def test_get_or_load_from_ref_with_inline(self, cache, sample_inline_def):
        """Test get_or_load_from_ref with inline definition."""
        mock_loaded_model = LoadedModel(
            model_id="inline:test",
            model_slug="test-slug",
            model=MagicMock(),
            format=AiModelFormat.ONNX,
            memory_mb=100,
            device="cpu",
        )

        inline_ref = ModelRef(inline=sample_inline_def)

        with patch.object(cache, 'get_or_load', new_callable=AsyncMock) as mock_get_or_load:
            mock_get_or_load.return_value = mock_loaded_model

            result = await cache.get_or_load_from_ref(
                inline_ref,
                ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
                db_model_config=None,  # No DB config needed for inline
            )

            # Should convert inline def to config
            mock_get_or_load.assert_called_once()
            call_args = mock_get_or_load.call_args[0][0]
            assert call_args.source_uri == "onnx-community/whisper-large-v3-turbo"
            assert result == mock_loaded_model

    @pytest.mark.asyncio
    async def test_get_or_load_from_ref_slug_without_db_config_fails(self, cache):
        """Test that slug ref without db config raises error."""
        from stt_v2.core.exceptions import ModelLoadError

        slug_ref = ModelRef(slug="whisper-test")

        with pytest.raises(ModelLoadError, match="has no database config"):
            await cache.get_or_load_from_ref(
                slug_ref,
                ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
                db_model_config=None,  # Missing!
            )


class TestModelCacheFormatSupport:
    """Tests for model format support in cache."""

    @pytest.fixture
    def cache(self):
        """Create a cache with test settings."""
        return ModelCache(
            max_memory_mb=5000,
            max_models=5,
            ttl_seconds=3600,
        )

    def test_loaders_include_onnx_optimum(self, cache):
        """Test that ONNX_OPTIMUM format has a loader."""
        loader = cache._get_loader(AiModelFormat.ONNX_OPTIMUM)
        assert loader is not None

    def test_loaders_include_ctranslate2(self, cache):
        """Test that CTRANSLATE2 format has a loader."""
        loader = cache._get_loader(AiModelFormat.CTRANSLATE2)
        assert loader is not None

    def test_loaders_include_azure_speech(self, cache):
        """Test that AZURE_SPEECH format has a loader."""
        loader = cache._get_loader(AiModelFormat.AZURE_SPEECH)
        assert loader is not None

    def test_azure_speech_loader_is_correct_type(self, cache):
        """Test that AZURE_SPEECH loader is an AzureSpeechLoader instance."""
        from stt_v2.models.azure_speech_loader import AzureSpeechLoader

        loader = cache._get_loader(AiModelFormat.AZURE_SPEECH)
        assert isinstance(loader, AzureSpeechLoader)

    def test_loaders_include_all_formats(self, cache):
        """Test that all formats have loaders."""
        formats_to_check = [
            AiModelFormat.SAFETENSOR,
            AiModelFormat.PYTORCH,
            AiModelFormat.ONNX,
            AiModelFormat.ONNX_OPTIMUM,
            AiModelFormat.NEMO,
            AiModelFormat.CTRANSLATE2,
            AiModelFormat.AZURE_SPEECH,
        ]

        for fmt in formats_to_check:
            loader = cache._get_loader(fmt)
            assert loader is not None, f"No loader for format {fmt}"


# =============================================================================
# EDGE CASE TESTS
# =============================================================================


class TestModelCacheEdgeCases:
    """Edge case tests for model cache robustness."""

    @pytest.fixture
    def small_cache(self):
        """Create a small cache for edge case testing."""
        return ModelCache(
            max_memory_mb=500,
            max_models=2,
            ttl_seconds=3600,
        )

    def create_model(self, slug: str, memory_mb: int = 100) -> LoadedModel:
        """Helper to create a LoadedModel for testing."""
        return LoadedModel(
            model_id=f"m-{slug}",
            model_slug=slug,
            model=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=memory_mb,
            device="cpu",
        )

    @pytest.mark.asyncio
    async def test_memory_limit_triggers_eviction(self, small_cache):
        """Test that memory limit triggers LRU eviction."""
        # Fill cache to memory limit (500MB)
        model1 = self.create_model("model-1", memory_mb=200)
        model2 = self.create_model("model-2", memory_mb=200)

        await small_cache.put("model-1", model1)
        await small_cache.put("model-2", model2)

        # Access model-1 to make it recently used
        await small_cache.get("model-1")

        # Adding model-3 should evict model-2 (LRU)
        model3 = self.create_model("model-3", memory_mb=200)
        await small_cache.put("model-3", model3)

        # model-2 should be evicted
        assert await small_cache.get("model-2") is None
        # model-1 should still be there
        assert await small_cache.get("model-1") is not None

    @pytest.mark.asyncio
    async def test_model_count_limit_triggers_eviction(self, small_cache):
        """Test that max_models limit triggers eviction."""
        # Small cache has max_models=2
        model1 = self.create_model("model-1", memory_mb=50)
        model2 = self.create_model("model-2", memory_mb=50)

        await small_cache.put("model-1", model1)
        await small_cache.put("model-2", model2)

        # Adding 3rd model should trigger eviction
        model3 = self.create_model("model-3", memory_mb=50)
        await small_cache.put("model-3", model3)

        stats = small_cache.stats()
        assert stats.total_models <= 2

    @pytest.mark.asyncio
    async def test_get_updates_access_time(self, small_cache):
        """Test that get updates last_accessed time."""
        model = self.create_model("model-test", memory_mb=50)
        await small_cache.put("model-test", model)

        initial_entry = small_cache._cache.get("model-test")
        initial_accessed = initial_entry.last_accessed

        # Wait a tiny bit
        import asyncio
        await asyncio.sleep(0.01)

        # Access the model
        await small_cache.get("model-test")

        final_entry = small_cache._cache.get("model-test")
        final_accessed = final_entry.last_accessed

        assert final_accessed > initial_accessed

    @pytest.mark.asyncio
    async def test_duplicate_put_updates_model(self, small_cache):
        """Test that putting same slug updates the model."""
        model_v1 = self.create_model("model-test", memory_mb=100)
        model_v2 = self.create_model("model-test", memory_mb=200)

        await small_cache.put("model-test", model_v1)
        await small_cache.put("model-test", model_v2)

        retrieved = await small_cache.get("model-test")
        assert retrieved.memory_mb == 200

    @pytest.mark.asyncio
    async def test_clear_resets_statistics(self, small_cache):
        """Test that clear resets cache statistics."""
        model = self.create_model("model-test", memory_mb=50)
        await small_cache.put("model-test", model)
        await small_cache.get("model-test")  # Register a hit
        await small_cache.get("nonexistent")  # Register a miss

        # Clear
        await small_cache.clear()

        stats = small_cache.stats()
        assert stats.total_models == 0
        assert stats.total_memory_mb == 0

    @pytest.mark.asyncio
    async def test_evict_returns_false_for_missing(self, small_cache):
        """Test evict returns False for non-existent key."""
        result = await small_cache.evict("nonexistent-model")
        assert result is False

    @pytest.mark.asyncio
    async def test_stats_accuracy(self, small_cache):
        """Test statistics are accurate."""
        model1 = self.create_model("model-1", memory_mb=100)
        model2 = self.create_model("model-2", memory_mb=150)

        await small_cache.put("model-1", model1)
        await small_cache.put("model-2", model2)

        # Generate hits and misses
        await small_cache.get("model-1")  # hit
        await small_cache.get("model-1")  # hit
        await small_cache.get("model-2")  # hit
        await small_cache.get("missing")  # miss

        stats = small_cache.stats()

        assert stats.total_models == 2
        assert stats.total_memory_mb == 250
        assert stats.hits == 3
        assert stats.misses == 1
        assert stats.hit_rate == pytest.approx(0.75)


class TestCacheEntryEdgeCases:
    """Edge case tests for CacheEntry."""

    def test_age_seconds_immediately_after_creation(self):
        """Test age_seconds immediately after creation is near zero."""
        model = LoadedModel(
            model_id="m-1",
            model_slug="test",
            model=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=100,
            device="cpu",
        )
        entry = CacheEntry(
            model=model,
            loaded_at=datetime.utcnow(),
            last_accessed=datetime.utcnow(),
        )

        assert entry.age_seconds < 1

    def test_idle_seconds_equals_age_when_never_accessed_after_load(self):
        """Test idle equals age when never accessed after load."""
        load_time = datetime.utcnow() - timedelta(seconds=60)
        model = LoadedModel(
            model_id="m-1",
            model_slug="test",
            model=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=100,
            device="cpu",
        )
        entry = CacheEntry(
            model=model,
            loaded_at=load_time,
            last_accessed=load_time,  # Same as load time
        )

        # age and idle should be approximately equal
        assert abs(entry.age_seconds - entry.idle_seconds) < 1
