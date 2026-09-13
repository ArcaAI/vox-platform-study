"""Pipeline configuration reader from database.

.. deprecated:: TASK-861
   The ASR Agent + gateway-resolved ``ResolvedAsrSpec`` (``stt.pipeline.spec``)
   replaced these readers: a session/job carries every model it needs, so this
   service reads no selection from Postgres. Both readers stay for the
   deprecated ``pipeline_id`` path only (removed in R4), warn on every use, and
   fail CLOSED (``DatabaseDisabledError``) while the connection is off.
"""

import logging
import warnings
from datetime import datetime
from typing import Any

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

# ── TASK-964: reconstructing what TASK-890 §3.11/L2 removed ──────────────────
#
# `localPath` stopped being a column and became a DERIVATION over the bucket
# identity; the gateway owns the canonical one (`derivedLocalPath` in
# `packages/applications/src/services/ai-model/constants.ts`). These two
# constants mirror it. They live HERE, local to the deprecated reader, rather
# than in a shared module on purpose: TASK-861 removed stt's dependency on this
# derivation for the live path, and re-exporting it would invite the spec-driven
# path to start using it again.

#: Mount point of the s3fs sidecar that serves `hope-models` in every pod.
_HOPE_MODELS_MOUNT = "/mnt/models-bucket"

#: Libraries whose loader opens ONE file, so the derived path names the primary
#: object rather than the directory holding it. Mirrors `SINGLE_FILE_LIBRARIES`.
_SINGLE_FILE_LIBRARIES = frozenset({"whisper.cpp", "llama.cpp", "onnxruntime", "parakeet.cpp"})


def _download_status_of(availability: str | None) -> AiModelDownloadStatus:
    """The retired `downloadStatus`, expressed through the column that replaced it.

    Only AVAILABLE means the weights are staged. Everything else — MISSING,
    PARTIAL, UNKNOWN, NOT_APPLICABLE — is reported NOT_DOWNLOADED rather than
    guessed at: this DTO field has four states and the measurement has five, so
    the mapping is deliberately lossy in the safe direction.
    """
    return (
        AiModelDownloadStatus.DOWNLOADED
        if availability == "AVAILABLE"
        else AiModelDownloadStatus.NOT_DOWNLOADED
    )


def _derived_local_path(model: "AiModelRead") -> str | None:
    """`/mnt/models-bucket/<bucketPrefix>[/<primaryObject>]`, or None.

    None when the row has no bucket identity — which is exactly the signal the
    resolvers use to fall back to `source_uri` scheme dispatch.
    """
    prefix = (model.bucket_prefix or "").strip().strip("/")
    if not prefix:
        return None
    base = f"{_HOPE_MODELS_MOUNT}/{prefix}"
    if model.library_name in _SINGLE_FILE_LIBRARIES and model.primary_object:
        return f"{base}/{model.primary_object.lstrip('/')}"
    return f"{base}/"


def _download_meta(metadata: dict[str, Any] | None) -> dict[str, Any]:
    """The `_metadata.download` block the publish job writes, or an empty dict."""
    if not isinstance(metadata, dict):
        return {}
    block = metadata.get("download")
    return block if isinstance(block, dict) else {}


def _download_meta_datetime(metadata: dict[str, Any] | None, key: str) -> datetime | None:
    """An ISO-8601 timestamp from the run bookkeeping, or None if absent/unparseable."""
    raw = _download_meta(metadata).get(key)
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _download_meta_int(metadata: dict[str, Any] | None, key: str) -> int | None:
    """An integer from the run bookkeeping, or None if absent or not a number."""
    raw = _download_meta(metadata).get(key)
    return int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else None


def _deprecated(what: str) -> None:
    warnings.warn(
        f"{what} is deprecated (TASK-861, removed in R4): apps/stt consumes the "
        "gateway-resolved ResolvedAsrSpec instead of reading AsrPipeline/AiModel rows.",
        DeprecationWarning,
        stacklevel=3,
    )


class PipelineConfigReader:
    """Read ASR pipeline configurations from database.

    .. deprecated:: TASK-861 — removed in R4; see the module docstring.
    """

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
        _deprecated("PipelineConfigReader.get_pipeline()")
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
        _deprecated("PipelineConfigReader.get_pipeline_by_slug()")
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
        _deprecated("PipelineConfigReader.get_enabled_pipelines()")
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
    """Read AI model registry from database.

    .. deprecated:: TASK-861 — removed in R4; see the module docstring.
    """

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
        _deprecated("ModelRegistryReader.get_model()")
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
        _deprecated("ModelRegistryReader.get_model_by_slug()")
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

        _deprecated("ModelRegistryReader.get_models_by_slugs()")
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
        _deprecated("ModelRegistryReader.get_downloaded_models()")
        async with get_session() as session:
            # TASK-964 — `downloadStatus` is gone (TASK-890 §3.11/L2). `availability`
            # is the MEASURED replacement: the bucket inventory writes it, and
            # AVAILABLE means the weights are really staged. NOT_APPLICABLE is
            # deliberately excluded here — it marks a cloud row or a library that
            # ships its own weights, neither of which this deprecated
            # "downloaded models" listing ever returned.
            query = select(AiModelRead).where(
                AiModelRead.availability == "AVAILABLE",
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
            # TASK-944 (B2) — the DECLARED loader-selection key, carried on this
            # deprecated path too so it selects like the spec-driven one.
            library_name=getattr(model, "library_name", None),
            memory_size_mb=model.memory_size_mb,
            compute_type=model.compute_type,
            # TASK-964 — all four were columns until TASK-890 §3.11/L2 dropped
            # them; they are reconstructed here so this deprecated path keeps its
            # DTO contract without the gateway having to keep dead columns alive.
            download_status=_download_status_of(model.availability),
            local_path=_derived_local_path(model),
            downloaded_at=_download_meta_datetime(model.extra_metadata, "finishedAt"),
            file_size_mb=_download_meta_int(model.extra_metadata, "sizeMb"),
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
