"""Pipeline DTOs and data structures."""

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any


class ModelTaskType(StrEnum):
    """Model task types for STT."""

    AUTOMATIC_SPEECH_RECOGNITION = "AUTOMATIC_SPEECH_RECOGNITION"
    VOICE_ACTIVITY_DETECTION = "VOICE_ACTIVITY_DETECTION"
    AUDIO_DENOISING = "AUDIO_DENOISING"
    AUDIO_TO_AUDIO = "AUDIO_TO_AUDIO"  # For noise suppression (RNNoise, etc.)
    SPEAKER_DIARIZATION = "SPEAKER_DIARIZATION"


class AiModelSource(StrEnum):
    """Model source types."""

    HUGGINGFACE = "HUGGINGFACE"
    GITHUB = "GITHUB"
    MLFLOW = "MLFLOW"  # Reserved: self-hosted MLFlow model registry
    KSERVE = "KSERVE"  # Reserved: MLFlow Serve + KServe inference
    LOCAL = "LOCAL"


class AiModelFormat(StrEnum):
    """Model format types / inference engines."""

    SAFETENSOR = "SAFETENSOR"
    ONNX = "ONNX"
    NEMO = "NEMO"
    PYTORCH = "PYTORCH"
    # Special formats for specific engines
    ONNX_OPTIMUM = "ONNX_OPTIMUM"  # HuggingFace Optimum ONNX
    CTRANSLATE2 = "CTRANSLATE2"  # CTranslate2 (faster-whisper)
    # Cloud-based engines (no local model, API-driven)
    AZURE_SPEECH = "AZURE_SPEECH"  # Azure Cognitive Services Speech


class AiModelDownloadStatus(StrEnum):
    """Model download status."""

    NOT_DOWNLOADED = "NOT_DOWNLOADED"
    DOWNLOADING = "DOWNLOADING"
    DOWNLOADED = "DOWNLOADED"
    DOWNLOAD_FAILED = "DOWNLOAD_FAILED"


# Valid ONNX quantization variants available in onnx-community models.
# None means default (fp32). These correspond to file name suffixes, e.g.,
# encoder_model_{variant}.onnx / decoder_model_merged_{variant}.onnx
VALID_ONNX_QUANTIZATIONS: list[str] = [
    "fp16",       # Float16 — ~50% size of fp32, minimal quality loss
    "int8",       # INT8 dynamic quantization
    "uint8",      # UINT8 dynamic quantization (same size as int8)
    "q4",         # 4-bit quantization — ~25% size of fp32
    "q4f16",      # 4-bit weights + float16 activations — smallest
    "bnb4",       # bitsandbytes 4-bit
    "quantized",  # Default quantized (typically int8)
]


# Whisper-supported language codes (ISO 639-1 / 639-3).
# Used for validation when a language hint is provided.
VALID_WHISPER_LANGUAGES: set[str] = {
    "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs",
    "ca", "cs", "cy", "da", "de", "el", "en", "es", "et", "eu", "fa", "fi",
    "fo", "fr", "gl", "gu", "ha", "haw", "he", "hi", "hr", "ht", "hu", "hy",
    "id", "is", "it", "ja", "jw", "ka", "kk", "km", "kn", "ko", "la", "lb",
    "ln", "lo", "lt", "lv", "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt",
    "my", "ne", "nl", "nn", "no", "oc", "pa", "pl", "ps", "pt", "ro", "ru",
    "sa", "sd", "si", "sk", "sl", "sn", "so", "sq", "sr", "su", "sv", "sw",
    "ta", "te", "tg", "th", "tk", "tl", "tr", "tt", "uk", "ur", "uz", "vi",
    "yi", "yo", "yue", "zh",
}


def is_valid_language_code(code: str) -> bool:
    """Check whether *code* is a recognised Whisper language code.

    Accepts bare ISO codes (``"en"``) as well as BCP-47 tags
    (``"en-US"``, ``"ml-IN"``).  The primary subtag (before the first
    ``-``) is validated against the known Whisper language set.
    """
    if not code:
        return False
    primary = code.split("-")[0].lower()
    return primary in VALID_WHISPER_LANGUAGES


# =============================================================================
# INLINE MODEL DEFINITION
# Allows administrators to specify models directly in pipeline YAML
# =============================================================================


@dataclass
class InlineModelDef:
    """
    Inline model definition for pipeline configuration.

    Allows admins to specify models directly with HuggingFace ID and engine,
    without requiring pre-registration in the AiModel table.

    Example YAML:
        models:
          asr:
            hf_model_id: "onnx-community/whisper-large-v3-turbo_timestamped"
            engine: "onnx"
            revision: "main"
            quantization: "q4"    # ONNX quantization variant (fp16, int8, q4, q4f16, bnb4, etc.)
            subfolder: "onnx"     # Subfolder within the HF repo (auto-detected for onnx-community)
          vad:
            hf_model_id: "snakers4/silero-vad"
            engine: "onnx"
            version: "v6.0"
    """

    hf_model_id: str  # HuggingFace model ID (e.g., "onnx-community/whisper-large-v3-turbo")
    engine: AiModelFormat  # Inference engine to use
    revision: str | None = None  # Git revision/branch
    version: str | None = None  # Model version (e.g., "v6.0" for Silero VAD)
    compute_type: str | None = None  # Override compute type (float16, float32, int8)
    device: str | None = None  # Override device (auto, cuda, cpu, mps)
    quantization: str | None = None  # ONNX quantization variant (fp16, int8, q4, q4f16, bnb4, etc.)
    subfolder: str | None = None  # Subfolder within the HF repo (e.g., "onnx")

    def to_ai_model_config(self, task_type: ModelTaskType) -> "AiModelConfig":
        """Convert inline definition to AiModelConfig for loader compatibility."""
        # Generate a slug from the model ID
        slug = self.hf_model_id.replace("/", "--").lower()
        if self.version:
            slug = f"{slug}-{self.version.replace('.', '-')}"
        if self.quantization:
            slug = f"{slug}-{self.quantization}"

        return AiModelConfig(
            id=f"inline:{slug}",
            tenant_id=None,
            slug=slug,
            name=self.hf_model_id,
            description=f"Inline model: {self.hf_model_id}",
            task_type=task_type,
            source=AiModelSource.HUGGINGFACE,
            source_uri=self.hf_model_id,
            source_revision=self.revision or self.version or "main",
            format=self.engine,
            memory_size_mb=None,
            compute_type=self.compute_type,
            download_status=AiModelDownloadStatus.NOT_DOWNLOADED,
            local_path=None,
            downloaded_at=None,
            file_size_mb=None,
            checksum=None,
            tags=[],
            quantization=self.quantization,
            subfolder=self.subfolder,
        )


@dataclass
class ModelRef:
    """
    A model reference that can be either a slug (string) or inline definition.

    Supports both formats:
    - String slug: "whisper-large-v3" (references AiModel table)
    - Inline definition: { hf_model_id: "...", engine: "..." }
    """

    slug: str | None = None  # Model slug (references AiModel table)
    inline: InlineModelDef | None = None  # Inline model definition

    @property
    def is_inline(self) -> bool:
        """Check if this is an inline model definition."""
        return self.inline is not None

    @property
    def identifier(self) -> str:
        """Get model identifier (slug or inline hf_model_id)."""
        if self.inline:
            return self.inline.hf_model_id
        return self.slug or ""

    @classmethod
    def from_value(cls, value: str | dict[str, Any]) -> "ModelRef":
        """
        Create ModelRef from YAML value.

        Args:
            value: Either a string slug or a dict with inline definition
        """
        if isinstance(value, str):
            return cls(slug=value)
        elif isinstance(value, dict):
            # Parse inline definition
            engine_str = value.get("engine", "safetensor").upper()
            # Normalize engine names
            engine_mapping = {
                "ONNX": AiModelFormat.ONNX,
                "SAFETENSOR": AiModelFormat.SAFETENSOR,
                "PYTORCH": AiModelFormat.PYTORCH,
                "NEMO": AiModelFormat.NEMO,
                "TRANSFORMERS": AiModelFormat.SAFETENSOR,
                "HF": AiModelFormat.SAFETENSOR,
                "HUGGINGFACE": AiModelFormat.SAFETENSOR,
                "CTRANSLATE2": AiModelFormat.CTRANSLATE2,
                "CT2": AiModelFormat.CTRANSLATE2,
                "OPTIMUM": AiModelFormat.ONNX_OPTIMUM,
                "AZURE_SPEECH": AiModelFormat.AZURE_SPEECH,
                "AZURE": AiModelFormat.AZURE_SPEECH,
            }
            engine = engine_mapping.get(engine_str, AiModelFormat.SAFETENSOR)

            inline = InlineModelDef(
                hf_model_id=value.get("hf_model_id", value.get("model_id", "")),
                engine=engine,
                revision=value.get("revision"),
                version=value.get("version"),
                compute_type=value.get("compute_type"),
                device=value.get("device"),
                quantization=value.get("quantization"),
                subfolder=value.get("subfolder"),
            )
            return cls(inline=inline)
        else:
            raise ValueError(f"Invalid model reference value: {value}")


@dataclass
class ModelRefs:
    """Model references in pipeline configuration."""

    asr: ModelRef  # ASR model (required)
    vad: ModelRef | None = None  # VAD model (optional)
    denoise: ModelRef | None = None  # Denoise/noise suppression model (optional)
    diarization: ModelRef | None = None  # Speaker diarization model (optional)

    def get_all_refs(self) -> list[tuple[str, ModelRef]]:
        """Get all non-None model references with their role."""
        refs = [("asr", self.asr)]
        if self.vad:
            refs.append(("vad", self.vad))
        if self.denoise:
            refs.append(("denoise", self.denoise))
        if self.diarization:
            refs.append(("diarization", self.diarization))
        return refs

    def get_all_slugs(self) -> list[str]:
        """Get all model slugs (for backward compatibility, excludes inline models)."""
        slugs = []
        if self.asr.slug:
            slugs.append(self.asr.slug)
        if self.vad and self.vad.slug:
            slugs.append(self.vad.slug)
        if self.denoise and self.denoise.slug:
            slugs.append(self.denoise.slug)
        if self.diarization and self.diarization.slug:
            slugs.append(self.diarization.slug)
        return slugs

    def get_inline_models(self) -> list[tuple[str, InlineModelDef]]:
        """Get all inline model definitions with their role."""
        inline_models = []
        if self.asr.is_inline and self.asr.inline:
            inline_models.append(("asr", self.asr.inline))
        if self.vad and self.vad.is_inline and self.vad.inline:
            inline_models.append(("vad", self.vad.inline))
        if self.denoise and self.denoise.is_inline and self.denoise.inline:
            inline_models.append(("denoise", self.denoise.inline))
        if self.diarization and self.diarization.is_inline and self.diarization.inline:
            inline_models.append(("diarization", self.diarization.inline))
        return inline_models


@dataclass
class VadConfig:
    """Voice Activity Detection configuration."""

    enabled: bool = True
    threshold: float = 0.6
    min_speech_duration_ms: int = 350
    min_silence_duration_ms: int = 100
    padding_ms: int = 30
    pre_speech_context_ms: int = 500


@dataclass
class DenoiseConfig:
    """Audio denoising configuration."""

    enabled: bool = False
    strength: float = 0.5


@dataclass
class DiarizationConfig:
    """Speaker diarization configuration."""

    enabled: bool = False
    # Cosine similarity threshold for speaker matching (0.0–1.0)
    similarity_threshold: float = 0.7
    # Maximum number of speakers (0 = unlimited)
    max_speakers: int = 0
    # Whether to create new speaker profiles when unknown speakers are detected
    auto_register_speakers: bool = True
    # Minimum segment duration (seconds) to attempt diarization on
    min_segment_duration_s: float = 1.0
    # Silence padding (ms) added before and after each VAD speech segment
    # when merging segments into the processed audio for storage.
    # Provides natural gaps between speaker turns for better playback quality.
    segment_silence_padding_ms: int = 100


@dataclass
class PreprocessingConfig:
    """Audio preprocessing configuration."""

    target_sample_rate: int = 16000
    normalize: bool = True
    vad: VadConfig = field(default_factory=VadConfig)
    denoise: DenoiseConfig = field(default_factory=DenoiseConfig)


@dataclass
class InferenceConfig:
    """Model inference configuration."""

    batch_size: int = 16
    compute_type: str = "auto"  # auto, float16, float32, int8
    device: str = "auto"  # auto, cuda, cpu
    num_workers: int = 4
    beam_size: int = 5
    temperature: float = 0.0
    language: str | None = None  # None = auto-detect
    code_switching: bool = False  # Enable multilingual code-switching


@dataclass
class TimestampConfig:
    """Timestamp extraction configuration."""

    word_timestamps: bool = True
    sentence_timestamps: bool = True


@dataclass
class PunctuationConfig:
    """Punctuation restoration configuration."""

    enabled: bool = True
    model: str | None = None  # Custom punctuation model


@dataclass
class PostprocessingConfig:
    """Postprocessing configuration."""

    timestamps: TimestampConfig = field(default_factory=TimestampConfig)
    punctuation: PunctuationConfig = field(default_factory=PunctuationConfig)
    remove_disfluencies: bool = False
    lowercase: bool = False


@dataclass
class PipelineSpec:
    """Full pipeline specification parsed from YAML."""

    version: str
    models: ModelRefs
    preprocessing: PreprocessingConfig
    inference: InferenceConfig
    postprocessing: PostprocessingConfig
    diarization: DiarizationConfig = field(default_factory=DiarizationConfig)


@dataclass
class PipelineConfig:
    """Complete pipeline configuration with metadata."""

    id: str
    tenant_id: str | None
    slug: str
    name: str
    description: str | None
    spec: PipelineSpec
    tags: list[str]
    created_at: datetime
    updated_at: datetime

    def get_required_model_slugs(self) -> list[str]:
        """Get all model slugs required by this pipeline."""
        return self.spec.models.get_all_slugs()


@dataclass
class AiModelConfig:
    """AI model configuration read from database."""

    id: str
    tenant_id: str | None
    slug: str
    name: str
    description: str | None
    task_type: ModelTaskType
    source: AiModelSource
    source_uri: str
    source_revision: str | None
    format: AiModelFormat
    memory_size_mb: int | None
    compute_type: str | None
    download_status: AiModelDownloadStatus
    local_path: str | None
    downloaded_at: datetime | None
    file_size_mb: int | None
    checksum: str | None
    tags: list[str]
    # ONNX-specific: quantization variant and subfolder within the HF repo
    quantization: str | None = None  # e.g., "q4", "fp16", "int8", "q4f16"
    subfolder: str | None = None  # e.g., "onnx" for onnx-community models

    @property
    def is_downloaded(self) -> bool:
        """Check if model is downloaded."""
        return self.download_status == AiModelDownloadStatus.DOWNLOADED

    @property
    def is_asr(self) -> bool:
        """Check if this is an ASR model."""
        return self.task_type == ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION

    @property
    def is_vad(self) -> bool:
        """Check if this is a VAD model."""
        return self.task_type == ModelTaskType.VOICE_ACTIVITY_DETECTION


@dataclass
class ValidationError:
    """Validation error details."""

    field: str
    message: str


@dataclass
class ValidationResult:
    """Result of pipeline validation."""

    valid: bool
    errors: list[ValidationError] = field(default_factory=list)

    def add_error(self, field: str, message: str) -> None:
        """Add a validation error."""
        self.errors.append(ValidationError(field=field, message=message))
        self.valid = False

    def get_error_messages(self) -> list[str]:
        """Get list of error messages."""
        return [f"{e.field}: {e.message}" for e in self.errors]
