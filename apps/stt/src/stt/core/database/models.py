"""SQLAlchemy models for read-only database access.

These models mirror the Prisma schema but are read-only.
All write operations go through the API Gateway.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, ENUM, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Base class for all models."""

    pass


# PostgreSQL ENUM types (must match Prisma schema)
# These are defined in the 'core' schema
ResourceStatusType = ENUM(
    "ENABLED",
    "DISABLED",
    "DELETED",
    "PENDING",
    "ARCHIVED",
    name="ResourceStatusType",
    schema="core",
    create_type=False,  # Don't create - already exists from Prisma
)

AiModelSourceType = ENUM(
    "HUGGINGFACE",
    "GITHUB",
    "MLFLOW",
    "LOCAL",
    "S3",  # S3/MinIO-compatible object storage (s3://bucket/prefix)
    name="AiModelSource",
    schema="core",
    create_type=False,
)

AiModelFormatType = ENUM(
    "SAFETENSOR",
    "ONNX",
    "NEMO",
    "PYTORCH",
    "CTRANSLATE2",
    "FASTER_WHISPER",
    "MLX",
    "GGUF",
    "ONNX_OPTIMUM",
    "AZURE_SPEECH",
    "AZURE_FOUNDRY",
    "PARAKEET_CPP",
    "CLOUD_API",
    "WHISPER_CPP",
    name="AiModelFormat",
    schema="core",
    create_type=False,
)

AiModelDownloadStatusType = ENUM(
    "NOT_DOWNLOADED",
    "DOWNLOADING",
    "DOWNLOADED",
    "DOWNLOAD_FAILED",
    name="AiModelDownloadStatus",
    schema="core",
    create_type=False,
)

ModelCategoryType = ENUM(
    "MULTI_MODAL",
    "VISION",
    "NLP",
    "AUDIO",
    "TABULAR",
    "UNKNOWN",
    name="ModelCategory",
    schema="core",
    create_type=False,
)

# Mirrors ModelTaskType in packages/database/src/prisma/db_main/enums.prisma —
# guarded against drift by tests/unit/test_db_enum_mirrors.py.
ModelTaskTypeEnum = ENUM(
    # Multimodal
    "IMAGE_TEXT_TO_TEXT",
    "VISUAL_QUESTION_ANSWERING",
    "DOCUMENT_QUESTION_ANSWERING",
    "VIDEO_TEXT_TO_TEXT",
    "ANY_TO_ANY",
    # Vision
    "DEPTH_ESTIMATION",
    "IMAGE_CLASSIFICATION",
    "OBJECT_DETECTION",
    "IMAGE_SEGMENTATION",
    "TEXT_TO_IMAGE",
    "IMAGE_TO_TEXT",
    "IMAGE_TO_IMAGE",
    "IMAGE_TO_VIDEO",
    "UNCONDITIONAL_IMAGE_GENERATION",
    "VIDEO_CLASSIFICATION",
    "TEXT_TO_VIDEO",
    "ZERO_SHOT_IMAGE_CLASSIFICATION",
    "MASK_GENERATION",
    "ZERO_SHOT_OBJECT_DETECTION",
    "TEXT_TO_3D",
    "IMAGE_TO_3D",
    "IMAGE_FEATURE_EXTRACTION",
    "KEYPOINT_DETECTION",
    # NLP
    "TEXT_CLASSIFICATION",
    "TOKEN_CLASSIFICATION",
    "TABLE_QUESTION_ANSWERING",
    "QUESTION_ANSWERING",
    "ZERO_SHOT_CLASSIFICATION",
    "TRANSLATION",
    "SUMMARIZATION",
    "FEATURE_EXTRACTION",
    "TEXT_GENERATION",
    "TEXT2TEXT_GENERATION",
    "FILL_MASK",
    "SENTENCE_SIMILARITY",
    "GUARDRAIL",
    # Audio
    "TEXT_TO_SPEECH",
    "TEXT_TO_AUDIO",
    "AUTOMATIC_SPEECH_RECOGNITION",
    "AUDIO_TO_AUDIO",
    "AUDIO_CLASSIFICATION",
    "VOICE_ACTIVITY_DETECTION",
    "SPEAKER_DIARIZATION",
    "SPEAKER_EMBEDDING",
    # Tabular
    "TABULAR_CLASSIFICATION",
    "TABULAR_REGRESSION",
    "TIME_SERIES_FORECASTING",
    # Unknown
    "UNKNOWN",
    name="ModelTaskType",
    schema="core",
    create_type=False,
)

ModelTypeEnum = ENUM(
    "BASE_MODEL",
    "FINETUNED_MODEL",
    "QUANTIZED_MODEL",
    "UNKNOWN",
    name="ModelType",
    schema="core",
    create_type=False,
)


# `GlobalSettingRead` was removed here. It mirrored the `core.GlobalSetting`
# table but had ZERO callers: the seed wrote `stt.config.model_cache.*` /
# `stt.config.workers.*` rows that nothing ever read. Those knobs now arrive
# over HTTP via `core/effective_config.py`, so the unused mapping is deleted
# rather than left as a second, dormant config lane.


class AsrPipelineRead(Base):
    """Read-only model for AsrPipeline table."""

    __tablename__ = "AsrPipeline"
    __table_args__ = {"schema": "core"}

    id: Mapped[str] = mapped_column(String, primary_key=True)
    tenant_id: Mapped[str | None] = mapped_column("tenantId", String)
    name: Mapped[str] = mapped_column(String)
    slug: Mapped[str] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(String)
    config_yaml: Mapped[str] = mapped_column("configYaml", Text)
    resource_status: Mapped[str] = mapped_column("resourceStatus", ResourceStatusType)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String), default=[])
    # Note: 'metadata' is reserved by SQLAlchemy DeclarativeBase, use 'extra_metadata' instead
    extra_metadata: Mapped[dict[str, Any] | None] = mapped_column("_metadata", JSONB)
    version: Mapped[int] = mapped_column("_version", Integer, default=1)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime)
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime)


class AiModelRead(Base):
    """Read-only model for AiModel table."""

    __tablename__ = "AiModel"
    __table_args__ = {"schema": "core"}

    id: Mapped[str] = mapped_column(String, primary_key=True)
    tenant_id: Mapped[str | None] = mapped_column("tenantId", String)
    name: Mapped[str] = mapped_column(String)
    slug: Mapped[str] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(String)
    category: Mapped[str] = mapped_column(ModelCategoryType)
    task_type: Mapped[str] = mapped_column("taskType", ModelTaskTypeEnum)
    model_type: Mapped[str] = mapped_column("modelType", ModelTypeEnum)
    source: Mapped[str] = mapped_column(AiModelSourceType)
    source_uri: Mapped[str] = mapped_column("sourceUri", String)
    source_revision: Mapped[str | None] = mapped_column("sourceRevision", String)
    format: Mapped[str] = mapped_column(AiModelFormatType)
    provider: Mapped[str | None] = mapped_column(String)
    architecture: Mapped[str | None] = mapped_column(String)
    memory_size_mb: Mapped[int | None] = mapped_column("memorySizeMb", Integer)
    compute_type: Mapped[str | None] = mapped_column("computeType", String)
    download_status: Mapped[str] = mapped_column("downloadStatus", AiModelDownloadStatusType)
    local_path: Mapped[str | None] = mapped_column("localPath", String)
    downloaded_at: Mapped[datetime | None] = mapped_column("downloadedAt", DateTime)
    file_size_mb: Mapped[int | None] = mapped_column("fileSizeMb", Integer)
    checksum: Mapped[str | None] = mapped_column(String)
    resource_status: Mapped[str] = mapped_column("resourceStatus", ResourceStatusType)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String), default=[])
    # Note: 'metadata' is reserved by SQLAlchemy DeclarativeBase, use 'extra_metadata' instead
    extra_metadata: Mapped[dict[str, Any] | None] = mapped_column("_metadata", JSONB)
    version: Mapped[int] = mapped_column("_version", Integer, default=1)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime)
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime)


PromptTemplateCategoryType = ENUM(
    "SYSTEM",
    "SUMMARY",
    "DNA_ANALYSIS",
    "CUSTOM",
    name="PromptTemplateCategory",
    schema="core",
    create_type=False,
)


class PromptTemplateRead(Base):
    """Read-only model for PromptTemplate table."""

    __tablename__ = "PromptTemplate"
    __table_args__ = {"schema": "core"}

    id: Mapped[str] = mapped_column(String, primary_key=True)
    tenant_id: Mapped[str] = mapped_column("tenantId", String)
    name: Mapped[str] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(String)
    content: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(PromptTemplateCategoryType)
    current_version_number: Mapped[int] = mapped_column("currentVersionNumber", Integer)
    resource_status: Mapped[str] = mapped_column("resourceStatus", ResourceStatusType)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime)
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime)
