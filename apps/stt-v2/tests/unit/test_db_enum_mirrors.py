"""TASK-506 — guard the SQLAlchemy Prisma-enum mirrors against drift.

The read-only models in ``stt_v2.core.database.models`` mirror Prisma enums
with ``create_type=False`` (Postgres owns the types). The Python-side value
lists must match ``packages/database/src/prisma/db_main/enums.prisma``: a bind
against a value missing from the mirror fails, and a stale list misleads
maintainers (pre-TASK-506 the format mirror was 9 values behind the schema and
category/task-type mirrors listed members that do not exist in Prisma at all).
"""

from stt_v2.core.database import models

PRISMA_AI_MODEL_FORMAT = {
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
}

PRISMA_MODEL_CATEGORY = {"MULTI_MODAL", "VISION", "NLP", "AUDIO", "TABULAR", "UNKNOWN"}

PRISMA_MODEL_TASK_TYPE = {
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
}


def test_ai_model_format_mirror_matches_prisma() -> None:
    assert set(models.AiModelFormatType.enums) == PRISMA_AI_MODEL_FORMAT


def test_model_category_mirror_matches_prisma() -> None:
    assert set(models.ModelCategoryType.enums) == PRISMA_MODEL_CATEGORY


def test_model_task_type_mirror_matches_prisma() -> None:
    assert set(models.ModelTaskTypeEnum.enums) == PRISMA_MODEL_TASK_TYPE


def test_ai_model_read_maps_task506_columns() -> None:
    cols = {c.name for c in models.AiModelRead.__table__.columns}
    assert {"provider", "architecture"} <= cols
