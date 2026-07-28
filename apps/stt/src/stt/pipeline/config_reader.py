"""Pipeline configuration reader from database."""

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database.connection import get_session
from ..core.database.models import AiModelRead, AsrPipelineRead
from ..core.exceptions import NotFoundError, ValidationError
from .dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
    PipelineConfig,
)
from .yaml_parser import get_yaml_parser

logger = logging.getLogger(__name__)


class PipelineConfigReader:
    """Read ASR pipeline configurations from database."""

    def __init__(self, session: AsyncSession | None = None):
        """
        Initialize config reader.

        Args:
            session: Optional SQLAlchemy session. If None, will create new session per operation.
        """
        self._session = session
        self._parser = get_yaml_parser()

    async def get_pipeline(self, pipeline_id: str, tenant_id: str | None = None) -> PipelineConfig:
        """
        Fetch pipeline by ID from database.

        Tenant filter.

        When ``tenant_id`` is provided, the query additionally requires
        ``AsrPipelineRead.tenant_id == tenant_id`` so STT cannot load a
        pipeline owned by a different tenant. This is defense-in-depth on
        top of the API gateway's own check; both layers must independently
        deny cross-tenant access.

        Args:
            pipeline_id: Pipeline ID
            tenant_id: Optional tenant ID for multi-tenant filtering.
                When set, pipelines belonging to any other tenant are
                treated as not-found.

        Returns:
            PipelineConfig

        Raises:
            NotFoundError: If pipeline not found (or belongs to another tenant)
            ValidationError: If pipeline config is invalid
        """
        async with get_session() as session:
            query = select(AsrPipelineRead).where(
                AsrPipelineRead.id == pipeline_id,
                AsrPipelineRead.resource_status.in_(["ENABLED", "ARCHIVED"]),
            )

            if tenant_id:
                query = query.where(AsrPipelineRead.tenant_id == tenant_id)

            result = await session.execute(query)
            pipeline = result.scalar_one_or_none()

            if not pipeline:
                raise NotFoundError(f"Pipeline {pipeline_id} not found")

            return self._to_pipeline_config(pipeline)

    async def get_pipeline_by_slug(self, slug: str, tenant_id: str | None = None) -> PipelineConfig:
        """
        Fetch pipeline by slug from database.

        Args:
            slug: Pipeline slug
            tenant_id: Optional tenant ID for multi-tenant filtering

        Returns:
            PipelineConfig

        Raises:
            NotFoundError: If pipeline not found
            ValidationError: If pipeline config is invalid
        """
        async with get_session() as session:
            query = select(AsrPipelineRead).where(
                AsrPipelineRead.slug == slug,
                AsrPipelineRead.resource_status == "ENABLED",
            )

            if tenant_id:
                query = query.where(AsrPipelineRead.tenant_id == tenant_id)

            result = await session.execute(query)
            pipeline = result.scalar_one_or_none()

            if not pipeline:
                raise NotFoundError(f"Pipeline with slug '{slug}' not found")

            return self._to_pipeline_config(pipeline)

    async def get_enabled_pipelines(self, tenant_id: str | None = None) -> list[PipelineConfig]:
        """
        Fetch all enabled pipelines.

        Args:
            tenant_id: Optional tenant ID for multi-tenant filtering

        Returns:
            List of PipelineConfig
        """
        async with get_session() as session:
            query = select(AsrPipelineRead).where(
                AsrPipelineRead.resource_status == "ENABLED",
            )

            if tenant_id:
                query = query.where(AsrPipelineRead.tenant_id == tenant_id)

            result = await session.execute(query)
            pipelines = result.scalars().all()

            configs = []
            for pipeline in pipelines:
                try:
                    configs.append(self._to_pipeline_config(pipeline))
                except ValidationError as e:
                    logger.warning(f"Skipping invalid pipeline {pipeline.id}: {e}")

            return configs

    def _to_pipeline_config(self, pipeline: AsrPipelineRead) -> PipelineConfig:
        """
        Convert database model to PipelineConfig.

        Args:
            pipeline: Database model

        Returns:
            PipelineConfig

        Raises:
            ValidationError: If YAML parsing fails
        """
        try:
            spec = self._parser.parse(pipeline.config_yaml)

            # Validate the spec
            validation = self._parser.validate(spec)
            if not validation.valid:
                raise ValidationError(
                    f"Invalid pipeline config: {', '.join(validation.get_error_messages())}"
                )

            return PipelineConfig(
                id=pipeline.id,
                tenant_id=pipeline.tenant_id,
                slug=pipeline.slug,
                name=pipeline.name,
                description=pipeline.description,
                spec=spec,
                tags=pipeline.tags or [],
                created_at=pipeline.created_at,
                updated_at=pipeline.updated_at,
            )
        except ValueError as e:
            raise ValidationError(f"Failed to parse pipeline YAML: {e}") from e


class ModelRegistryReader:
    """Read AI model registry from database."""

    async def get_model(self, model_id: str) -> AiModelConfig:
        """
        Get model config by ID.

        Args:
            model_id: Model ID

        Returns:
            AiModelConfig

        Raises:
            NotFoundError: If model not found
        """
        async with get_session() as session:
            result = await session.execute(
                select(AiModelRead).where(
                    AiModelRead.id == model_id,
                    AiModelRead.resource_status == "ENABLED",
                )
            )
            model = result.scalar_one_or_none()

            if not model:
                raise NotFoundError(f"Model {model_id} not found")

            return self._to_model_config(model)

    async def get_model_by_slug(self, slug: str, tenant_id: str | None = None) -> AiModelConfig:
        """
        Get model config by slug.

        Args:
            slug: Model slug
            tenant_id: Optional tenant ID

        Returns:
            AiModelConfig

        Raises:
            NotFoundError: If model not found
        """
        async with get_session() as session:
            query = select(AiModelRead).where(
                AiModelRead.slug == slug,
                AiModelRead.resource_status == "ENABLED",
            )

            if tenant_id:
                query = query.where(AiModelRead.tenant_id == tenant_id)

            result = await session.execute(query)
            model = result.scalar_one_or_none()

            if not model:
                raise NotFoundError(f"Model with slug '{slug}' not found")

            return self._to_model_config(model)

    async def get_models_by_slugs(
        self, slugs: list[str], tenant_id: str | None = None
    ) -> list[AiModelConfig]:
        """
        Get multiple model configs by slugs.

        Args:
            slugs: List of model slugs
            tenant_id: Optional tenant ID

        Returns:
            List of AiModelConfig (may be shorter than slugs if some not found)
        """
        if not slugs:
            return []

        async with get_session() as session:
            query = select(AiModelRead).where(
                AiModelRead.slug.in_(slugs),
                AiModelRead.resource_status == "ENABLED",
            )

            if tenant_id:
                query = query.where(AiModelRead.tenant_id == tenant_id)

            result = await session.execute(query)
            models = result.scalars().all()

            return [self._to_model_config(m) for m in models]

    async def get_downloaded_models(self, tenant_id: str | None = None) -> list[AiModelConfig]:
        """
        Get all downloaded models.

        Args:
            tenant_id: Optional tenant ID

        Returns:
            List of AiModelConfig
        """
        async with get_session() as session:
            query = select(AiModelRead).where(
                AiModelRead.download_status == "DOWNLOADED",
                AiModelRead.resource_status == "ENABLED",
            )

            if tenant_id:
                query = query.where(AiModelRead.tenant_id == tenant_id)

            result = await session.execute(query)
            models = result.scalars().all()

            return [self._to_model_config(m) for m in models]

    async def get_models_for_pipeline(self, pipeline: PipelineConfig) -> dict[str, AiModelConfig]:
        """
        Get all models required by a pipeline.

        Args:
            pipeline: Pipeline configuration

        Returns:
            Dict mapping model slug to AiModelConfig
        """
        slugs = pipeline.get_required_model_slugs()
        models = await self.get_models_by_slugs(slugs, pipeline.tenant_id)

        return {m.slug: m for m in models}

    def _to_model_config(self, model: AiModelRead) -> AiModelConfig:
        """Convert database model to AiModelConfig.

        The DB catalog carries formats the STT runtime does not execute
        (MLX/GGUF are LM-Studio-served LLM rows); referencing one from a
        pipeline must fail with a clear message, not a bare enum ValueError.
        """
        try:
            model_task_type = ModelTaskType(model.task_type)
        except ValueError:
            raise ValueError(
                f"Model '{model.slug}' has task type '{model.task_type}', which "
                "the STT runtime does not recognise (catalog-only task type)."
            ) from None
        try:
            model_format = AiModelFormat(model.format)
        except ValueError:
            raise ValueError(
                f"Model '{model.slug}' has format '{model.format}', which the "
                "STT runtime does not execute (it is a catalog-only format, "
                "e.g. an LM-Studio-served LLM). Reference an ASR-capable model "
                "in the pipeline YAML instead."
            ) from None
        return AiModelConfig(
            id=model.id,
            tenant_id=model.tenant_id,
            slug=model.slug,
            name=model.name,
            description=model.description,
            task_type=model_task_type,
            source=AiModelSource(model.source),
            source_uri=model.source_uri,
            source_revision=model.source_revision,
            format=model_format,
            memory_size_mb=model.memory_size_mb,
            compute_type=model.compute_type,
            download_status=AiModelDownloadStatus(model.download_status),
            local_path=model.local_path,
            downloaded_at=model.downloaded_at,
            file_size_mb=model.file_size_mb,
            checksum=model.checksum,
            tags=model.tags or [],
        )


# Singleton instances
_pipeline_reader: PipelineConfigReader | None = None
_model_reader: ModelRegistryReader | None = None


def get_pipeline_reader() -> PipelineConfigReader:
    """Get singleton pipeline config reader."""
    global _pipeline_reader
    if _pipeline_reader is None:
        _pipeline_reader = PipelineConfigReader()
    return _pipeline_reader


def get_model_reader() -> ModelRegistryReader:
    """Get singleton model registry reader."""
    global _model_reader
    if _model_reader is None:
        _model_reader = ModelRegistryReader()
    return _model_reader
