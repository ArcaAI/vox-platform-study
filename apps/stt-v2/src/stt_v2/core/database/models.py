"""SQLAlchemy models for read-only database access.

These models mirror the Prisma schema but are read-only.
All write operations go through the API Gateway.
"""

from datetime import datetime

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
    name="AiModelSource",
    schema="core",
    create_type=False,
)

AiModelFormatType = ENUM(
    "SAFETENSOR",
    "ONNX",
    "NEMO",
    "PYTORCH",
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
    "AUDIO",
    "TEXT",
    "VISION",
    "MULTIMODAL",
    name="ModelCategory",
    schema="core",
    create_type=False,
)

ModelTaskTypeEnum = ENUM(
    "AUTOMATIC_SPEECH_RECOGNITION",
    "VOICE_ACTIVITY_DETECTION",
    "AUDIO_DENOISING",
    "AUDIO_TO_AUDIO",
    "SPEAKER_DIARIZATION",
    "TEXT_TO_SPEECH",
    "LANGUAGE_MODEL",
    "TRANSLATION",
    "SUMMARIZATION",
    "TEXT_CLASSIFICATION",
    "NAMED_ENTITY_RECOGNITION",
    "IMAGE_CLASSIFICATION",
    "OBJECT_DETECTION",
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


class GlobalSettingRead(Base):
    """Read-only model for GlobalSetting table."""

    __tablename__ = "GlobalSetting"
    __table_args__ = {"schema": "core"}

    id: Mapped[str] = mapped_column(String, primary_key=True)
    tenant_id: Mapped[str | None] = mapped_column("tenantId", String)
    name: Mapped[str] = mapped_column(String)
    key: Mapped[str] = mapped_column(String)
    namespace: Mapped[str | None] = mapped_column(String)
    value: Mapped[str] = mapped_column(String)
    default_value: Mapped[str | None] = mapped_column("defaultValue", String)
    data_type: Mapped[str] = mapped_column("dataType", String)
    description: Mapped[str | None] = mapped_column(String)
    resource_status: Mapped[str] = mapped_column("resourceStatus", ResourceStatusType)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String), default=[])
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime)
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime)


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
    extra_metadata: Mapped[dict | None] = mapped_column("_metadata", JSONB)
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
    extra_metadata: Mapped[dict | None] = mapped_column("_metadata", JSONB)
    version: Mapped[int] = mapped_column("_version", Integer, default=1)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime)
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime)
