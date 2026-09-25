"""Pipeline domain module.

The runtime dataclasses an ASR engine chain is built from. Selection arrives as the
gateway-resolved ``ResolvedAsrSpec`` (``stt.pipeline.spec``); this service reads no
pipeline or model rows (TASK-861, TASK-1006).
"""

from .dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    DenoiseConfig,
    InferenceConfig,
    InlineModelDef,
    ModelRef,
    ModelRefs,
    ModelTaskType,
    PipelineConfig,
    PipelineSpec,
    PostprocessingConfig,
    PreprocessingConfig,
    PunctuationConfig,
    TimestampConfig,
    VadConfig,
    ValidationError,
    ValidationResult,
)
from .yaml_parser import PipelineYamlParser, get_yaml_parser

__all__ = [
    # YAML parser
    "PipelineYamlParser",
    "get_yaml_parser",
    # DTOs
    "PipelineConfig",
    "PipelineSpec",
    "InlineModelDef",
    "ModelRef",
    "ModelRefs",
    "PreprocessingConfig",
    "VadConfig",
    "DenoiseConfig",
    "InferenceConfig",
    "PostprocessingConfig",
    "TimestampConfig",
    "PunctuationConfig",
    "AiModelConfig",
    "ValidationResult",
    "ValidationError",
    # Enums
    "ModelTaskType",
    "AiModelSource",
    "AiModelFormat",
    "AiModelDownloadStatus",
]
