"""Unit tests for Pipeline config reader."""

import os
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_MODEL_BASE = (
    os.environ.get("HUGGINGFACE_CACHE_DIR")
    or os.environ.get("HF_HOME")
    or os.path.join(os.sep, "models", "hf-cache")
)

from stt.core.exceptions import NotFoundError, ValidationError
from stt.pipeline.config_reader import (
    ModelRegistryReader,
    PipelineConfigReader,
    get_model_reader,
    get_pipeline_reader,
)
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
    PipelineConfig,
)


class TestPipelineConfigReader:
    """Tests for PipelineConfigReader."""

    @pytest.fixture
    def reader(self):
        return PipelineConfigReader()

    @pytest.fixture
    def mock_pipeline_row(self):
        """Create mock pipeline row from database."""
        mock = MagicMock()
        mock.id = "p-123"
        mock.tenant_id = "t-456"
        mock.slug = "default-pipeline"
        mock.name = "Default Pipeline"
        mock.description = "Test pipeline"
        mock.config_yaml = """
version: "1.0"
models:
  asr: whisper-large-v3
  vad: silero-vad
preprocessing:
  target_sample_rate: 16000
inference:
  batch_size: 16
"""
        mock.tags = ["production", "english"]
        mock.resource_status = "ENABLED"
        mock.created_at = datetime(2024, 1, 1)
        mock.updated_at = datetime(2024, 1, 2)
        return mock

    @pytest.mark.asyncio
    async def test_get_pipeline_success(self, reader, mock_pipeline_row):
        """Test getting pipeline by ID."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = mock_pipeline_row

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            result = await reader.get_pipeline("p-123")

            assert isinstance(result, PipelineConfig)
            assert result.id == "p-123"
            assert result.slug == "default-pipeline"
            assert result.spec.models.asr.slug == "whisper-large-v3"

    @pytest.mark.asyncio
    async def test_get_pipeline_not_found(self, reader):
        """Test getting non-existent pipeline."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            with pytest.raises(NotFoundError) as exc_info:
                await reader.get_pipeline("nonexistent")

            assert "not found" in str(exc_info.value).lower()

    # Tenant filter on get_pipeline.
    @pytest.mark.asyncio
    async def test_get_pipeline_tenant_filter_matches(self, reader, mock_pipeline_row):
        """When tenant_id matches, the row is returned."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = mock_pipeline_row

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            result = await reader.get_pipeline("p-123", tenant_id="t-456")

            assert isinstance(result, PipelineConfig)
            assert result.id == "p-123"

    @pytest.mark.asyncio
    async def test_get_pipeline_tenant_filter_rejects_cross_tenant(self, reader):
        """When tenant_id does not match, the DB filter returns nothing and a
        NotFoundError is raised. The tenant filter is enforced at the SQL
        level (the mocked session returns None for the tenant-bound query).
        """
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            with pytest.raises(NotFoundError):
                await reader.get_pipeline("p-123", tenant_id="t-other")

    @pytest.mark.asyncio
    async def test_get_pipeline_tenant_filter_is_optional(self, reader, mock_pipeline_row):
        """Omitting tenant_id preserves the legacy unfiltered behaviour."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = mock_pipeline_row

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            result = await reader.get_pipeline("p-123")
            assert isinstance(result, PipelineConfig)

    @pytest.mark.asyncio
    async def test_get_pipeline_by_slug_success(self, reader, mock_pipeline_row):
        """Test getting pipeline by slug."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = mock_pipeline_row

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            result = await reader.get_pipeline_by_slug("default-pipeline", "t-456")

            assert result.slug == "default-pipeline"

    @pytest.mark.asyncio
    async def test_get_pipeline_by_slug_not_found(self, reader):
        """Test getting non-existent pipeline by slug."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            with pytest.raises(NotFoundError):
                await reader.get_pipeline_by_slug("nonexistent")

    @pytest.mark.asyncio
    async def test_get_enabled_pipelines(self, reader, mock_pipeline_row):
        """Test getting all enabled pipelines."""
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [mock_pipeline_row]

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            results = await reader.get_enabled_pipelines("t-456")

            assert len(results) == 1
            assert results[0].id == "p-123"

    @pytest.mark.asyncio
    async def test_get_enabled_pipelines_skips_invalid(self, reader):
        """Test that invalid pipelines are skipped."""
        # Valid pipeline
        valid_row = MagicMock()
        valid_row.id = "p-valid"
        valid_row.tenant_id = "t-1"
        valid_row.slug = "valid"
        valid_row.name = "Valid"
        valid_row.description = None
        valid_row.config_yaml = 'version: "1.0"\nmodels:\n  asr: whisper'
        valid_row.tags = []
        valid_row.resource_status = "ENABLED"
        valid_row.created_at = datetime.utcnow()
        valid_row.updated_at = datetime.utcnow()

        # Invalid pipeline (bad YAML)
        invalid_row = MagicMock()
        invalid_row.id = "p-invalid"
        invalid_row.tenant_id = "t-1"
        invalid_row.slug = "invalid"
        invalid_row.name = "Invalid"
        invalid_row.description = None
        invalid_row.config_yaml = "not valid yaml: {{"
        invalid_row.tags = []
        invalid_row.resource_status = "ENABLED"
        invalid_row.created_at = datetime.utcnow()
        invalid_row.updated_at = datetime.utcnow()

        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [valid_row, invalid_row]

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            results = await reader.get_enabled_pipelines()

            # Should only have the valid one
            assert len(results) == 1
            assert results[0].id == "p-valid"

    def test_to_pipeline_config_invalid_yaml(self, reader):
        """Test conversion with invalid YAML."""
        mock_row = MagicMock()
        mock_row.id = "p-1"
        mock_row.config_yaml = "invalid: yaml: {"

        with pytest.raises(ValidationError):
            reader._to_pipeline_config(mock_row)


class TestModelRegistryReader:
    """Tests for ModelRegistryReader."""

    @pytest.fixture
    def reader(self):
        return ModelRegistryReader()

    @pytest.fixture
    def mock_model_row(self):
        """Create mock model row from database."""
        mock = MagicMock()
        mock.id = "m-123"
        mock.tenant_id = "t-456"
        mock.slug = "whisper-large-v3"
        mock.name = "Whisper Large V3"
        mock.description = "OpenAI Whisper model"
        mock.task_type = "AUTOMATIC_SPEECH_RECOGNITION"
        mock.source = "HUGGINGFACE"
        mock.source_uri = "openai/whisper-large-v3"
        mock.source_revision = None
        mock.format = "SAFETENSOR"
        mock.memory_size_mb = 3000
        mock.compute_type = "float16"
        mock.download_status = "DOWNLOADED"
        mock.local_path = os.path.join(_MODEL_BASE, "whisper")
        mock.downloaded_at = datetime(2024, 1, 1)
        mock.file_size_mb = 3000
        mock.checksum = "abc123"
        mock.tags = ["asr", "english"]
        mock.resource_status = "ENABLED"
        return mock

    @pytest.mark.asyncio
    async def test_get_model_success(self, reader, mock_model_row):
        """Test getting model by ID."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = mock_model_row

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            result = await reader.get_model("m-123")

            assert isinstance(result, AiModelConfig)
            assert result.id == "m-123"
            assert result.slug == "whisper-large-v3"
            assert result.task_type == ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION
            assert result.format == AiModelFormat.SAFETENSOR

    @pytest.mark.asyncio
    async def test_get_model_not_found(self, reader):
        """Test getting non-existent model."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            with pytest.raises(NotFoundError):
                await reader.get_model("nonexistent")

    @pytest.mark.asyncio
    async def test_get_model_by_slug_success(self, reader, mock_model_row):
        """Test getting model by slug."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = mock_model_row

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            result = await reader.get_model_by_slug("whisper-large-v3", "t-456")

            assert result.slug == "whisper-large-v3"

    @pytest.mark.asyncio
    async def test_get_models_by_slugs_empty(self, reader):
        """Test getting models with empty slugs list."""
        result = await reader.get_models_by_slugs([])

        assert result == []

    @pytest.mark.asyncio
    async def test_get_models_by_slugs_success(self, reader, mock_model_row):
        """Test getting multiple models by slugs."""
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [mock_model_row]

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            results = await reader.get_models_by_slugs(["whisper-large-v3"])

            assert len(results) == 1
            assert results[0].slug == "whisper-large-v3"

    @pytest.mark.asyncio
    async def test_get_downloaded_models(self, reader, mock_model_row):
        """Test getting downloaded models."""
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [mock_model_row]

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            results = await reader.get_downloaded_models("t-456")

            assert len(results) == 1

    @pytest.mark.asyncio
    async def test_get_models_for_pipeline(self, reader, mock_model_row):
        """Test getting models for a pipeline."""
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [mock_model_row]

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)

        mock_context = AsyncMock()
        mock_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_context.__aexit__ = AsyncMock(return_value=None)

        # Create mock pipeline config
        mock_pipeline = MagicMock()
        mock_pipeline.tenant_id = "t-456"
        mock_pipeline.get_required_model_slugs.return_value = ["whisper-large-v3"]

        with patch("stt.pipeline.config_reader.get_session", return_value=mock_context):
            results = await reader.get_models_for_pipeline(mock_pipeline)

            assert "whisper-large-v3" in results
            assert results["whisper-large-v3"].slug == "whisper-large-v3"

    def test_to_model_config(self, reader, mock_model_row):
        """Test conversion to AiModelConfig."""
        result = reader._to_model_config(mock_model_row)

        assert result.id == "m-123"
        assert result.slug == "whisper-large-v3"
        assert result.task_type == ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION
        assert result.source == AiModelSource.HUGGINGFACE
        assert result.format == AiModelFormat.SAFETENSOR
        assert result.download_status == AiModelDownloadStatus.DOWNLOADED
        assert result.is_downloaded is True
        assert result.is_asr is True


class TestSingletons:
    """Tests for singleton instances."""

    def test_get_pipeline_reader_singleton(self):
        """Test pipeline reader singleton."""
        # Reset singleton
        import stt.pipeline.config_reader as module

        module._pipeline_reader = None

        reader1 = get_pipeline_reader()
        reader2 = get_pipeline_reader()

        assert reader1 is reader2

    def test_get_model_reader_singleton(self):
        """Test model reader singleton."""
        import stt.pipeline.config_reader as module

        module._model_reader = None

        reader1 = get_model_reader()
        reader2 = get_model_reader()

        assert reader1 is reader2
