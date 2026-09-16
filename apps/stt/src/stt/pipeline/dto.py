"""Pipeline DTOs and data structures."""

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any, ClassVar


class ModelTaskType(StrEnum):
    """Model task types for STT."""

    AUTOMATIC_SPEECH_RECOGNITION = "AUTOMATIC_SPEECH_RECOGNITION"
    VOICE_ACTIVITY_DETECTION = "VOICE_ACTIVITY_DETECTION"
    AUDIO_DENOISING = "AUDIO_DENOISING"
    AUDIO_TO_AUDIO = "AUDIO_TO_AUDIO"  # For noise suppression (RNNoise, etc.)
    SPEAKER_DIARIZATION = "SPEAKER_DIARIZATION"
    # Feature extractors (e.g. ECAPA) in the catalog.
    SPEAKER_EMBEDDING = "SPEAKER_EMBEDDING"


class AiModelSource(StrEnum):
    """Model source types."""

    HUGGINGFACE = "HUGGINGFACE"
    GITHUB = "GITHUB"
    MLFLOW = "MLFLOW"  # Reserved: self-hosted MLFlow model registry
    KSERVE = "KSERVE"  # Reserved: MLFlow Serve + KServe inference
    LOCAL = "LOCAL"
    S3 = "S3"  # S3/MinIO-compatible object storage (s3://bucket/prefix)


class AiModelFormat(StrEnum):
    """Model format types / inference engines."""

    SAFETENSOR = "SAFETENSOR"
    ONNX = "ONNX"
    NEMO = "NEMO"
    PYTORCH = "PYTORCH"
    # Special formats for specific engines
    ONNX_OPTIMUM = "ONNX_OPTIMUM"  # HuggingFace Optimum ONNX
    CTRANSLATE2 = "CTRANSLATE2"  # CTranslate2 (legacy alias, loads via transformers)
    # faster-whisper on CTranslate2. hf_model_id is a CT2-converted model
    # repo/path, loaded via FasterWhisperLoader.
    FASTER_WHISPER = "FASTER_WHISPER"
    # Cloud-based engines (no local model, API-driven)
    AZURE_SPEECH = "AZURE_SPEECH"  # Azure Cognitive Services Speech
    # Azure AI Foundry LLM Speech API (MAI-Transcribe family).
    # PREVIEW: disabled by default, batch-only.
    AZURE_FOUNDRY = "AZURE_FOUNDRY"
    # parakeet.cpp (ggml runtime, mudler/parakeet.cpp) for NVIDIA Parakeet /
    # nemotron-3.5-asr-streaming models. CPU/Metal/CUDA.
    PARAKEET_CPP = "PARAKEET_CPP"
    # whisper.cpp (ggml runtime, ggml-org/whisper.cpp) for GGUF
    # whisper-large-v3-turbo. CPU/Metal/CUDA, via the pywhispercpp binding.
    WHISPER_CPP = "WHISPER_CPP"
    # Cloud BYOK speech providers (REST, no local model). tenant
    # fallback engines. Superset of the Prisma AiModelFormat enum (like KSERVE
    # on AiModelSource) — reachable via the `provider :: model` YAML shorthand,
    # not a DB `format` value, so no Prisma enum migration is implied.
    SARVAM = "SARVAM"  # Sarvam AI speech-to-text (saaras family)
    OPENAI = "OPENAI"  # OpenAI speech-to-text (gpt-4o-transcribe family)


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
    "fp16",  # Float16 — ~50% size of fp32, minimal quality loss
    "int8",  # INT8 dynamic quantization
    "uint8",  # UINT8 dynamic quantization (same size as int8)
    "q4",  # 4-bit quantization — ~25% size of fp32
    "q4f16",  # 4-bit weights + float16 activations — smallest
    "bnb4",  # bitsandbytes 4-bit
    "quantized",  # Default quantized (typically int8)
]


# Whisper-supported language codes (ISO 639-1 / 639-3).
# Used for validation when a language hint is provided.
VALID_WHISPER_LANGUAGES: set[str] = {
    "af",
    "am",
    "ar",
    "as",
    "az",
    "ba",
    "be",
    "bg",
    "bn",
    "bo",
    "br",
    "bs",
    "ca",
    "cs",
    "cy",
    "da",
    "de",
    "el",
    "en",
    "es",
    "et",
    "eu",
    "fa",
    "fi",
    "fo",
    "fr",
    "gl",
    "gu",
    "ha",
    "haw",
    "he",
    "hi",
    "hr",
    "ht",
    "hu",
    "hy",
    "id",
    "is",
    "it",
    "ja",
    "jw",
    "ka",
    "kk",
    "km",
    "kn",
    "ko",
    "la",
    "lb",
    "ln",
    "lo",
    "lt",
    "lv",
    "mg",
    "mi",
    "mk",
    "ml",
    "mn",
    "mr",
    "ms",
    "mt",
    "my",
    "ne",
    "nl",
    "nn",
    "no",
    "oc",
    "pa",
    "pl",
    "ps",
    "pt",
    "ro",
    "ru",
    "sa",
    "sd",
    "si",
    "sk",
    "sl",
    "sn",
    "so",
    "sq",
    "sr",
    "su",
    "sv",
    "sw",
    "ta",
    "te",
    "tg",
    "th",
    "tk",
    "tl",
    "tr",
    "tt",
    "uk",
    "ur",
    "uz",
    "vi",
    "yi",
    "yo",
    "yue",
    "zh",
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


def primary_language_subtag(code: str | None) -> str | None:
    """First language subtag of a (possibly paired or BCP-47) code.

    Whisper.cpp and the transformers Whisper runtime pin a SINGLE decode
    language, so a code-switch pair (``"ml-en"``) or a BCP-47 tag (``"ml-IN"``)
    collapses to its primary subtag (``"ml"``): the pipeline may carry
    ``language: "ml-en"`` to signal the code-switch pair, and the engine pins the
    FIRST language (``"ml"``) — a code-switch-capable model then still emits the
    paired language. Empty / ``None`` stays ``None`` (auto-detect / LID).
    """
    if not code:
        return None
    return code.split("-")[0].lower() or None


VALID_PARAKEET_V3_LANGUAGES: set[str] = {
    "bg",
    "hr",
    "cs",
    "da",
    "nl",
    "en",
    "et",
    "fi",
    "fr",
    "de",
    "el",
    "hu",
    "it",
    "lv",
    "lt",
    "mt",
    "pl",
    "pt",
    "ro",
    "sk",
    "sl",
    "es",
    "sv",
    "ru",
    "uk",
}


_INITIAL_PROMPT_CAPABLE_ENGINES: set[AiModelFormat] = {
    AiModelFormat.SAFETENSOR,
    AiModelFormat.PYTORCH,
    AiModelFormat.ONNX,
    AiModelFormat.ONNX_OPTIMUM,
    AiModelFormat.CTRANSLATE2,
    AiModelFormat.FASTER_WHISPER,
}


# CTranslate2-supported compute types. Used to validate
# models.asr.compute_type when engine is FASTER_WHISPER. Device-specific
# coercion (e.g. float16 on CPU) happens at load time.
VALID_CT2_COMPUTE_TYPES: list[str] = [
    "auto",
    "default",
    "int8",
    "int8_float16",
    "int8_bfloat16",
    "int8_float32",
    "int16",
    "float16",
    "bfloat16",
    "float32",
]


def engine_supports_initial_prompt(engine: AiModelFormat) -> bool:
    return engine in _INITIAL_PROMPT_CAPABLE_ENGINES


def is_valid_language_for_engine(code: str, engine: AiModelFormat) -> bool:
    if not code:
        return False
    primary = code.split("-")[0].lower()
    if engine == AiModelFormat.NEMO:
        # NEMO (Parakeet) supports only the Parakeet-v3 language set. The
        # earlier Whisper-set fallback masked unsupported languages (e.g. 'ml'
        # is Whisper-only) until runtime.
        return primary in VALID_PARAKEET_V3_LANGUAGES
    if engine in (AiModelFormat.AZURE_FOUNDRY, AiModelFormat.PARAKEET_CPP):
        # Locale coverage is model/service-side (MAI: 43 langs; nemotron-3.5:
        # 40 locales) and evolves with releases; accept any plausible primary
        # tag and let the engine reject unsupported ones.
        return primary.isalpha() and 2 <= len(primary) <= 3
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
    attn_implementation: str | None = None  # "flash_attention_2", "sdpa", or None

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
            device=self.device,
            attn_implementation=self.attn_implementation,
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

    # `provider :: model[@rev]` shorthand providers. Values are engine strings
    # resolved through the same engine_mapping below, so the two vocabularies
    # stay consistent.
    _PROVIDER_ALIASES: ClassVar[dict[str, str]] = {
        "transformer": "SAFETENSOR",
        "transformers": "SAFETENSOR",
        "safetensor": "SAFETENSOR",
        "hf": "SAFETENSOR",
        "huggingface": "SAFETENSOR",
        "pytorch": "PYTORCH",
        "onnx": "ONNX",
        "onnx-optimum": "ONNX_OPTIMUM",
        "optimum": "ONNX_OPTIMUM",
        "nemo": "NEMO",
        "faster-whisper": "FASTER_WHISPER",
        "faster_whisper": "FASTER_WHISPER",
        "ctranslate2": "CTRANSLATE2",
        "ct2": "CTRANSLATE2",
        "azure": "AZURE_SPEECH",
        "azure-speech": "AZURE_SPEECH",
        "azure-foundry": "AZURE_FOUNDRY",
        "parakeet.cpp": "PARAKEET_CPP",
        "whisper.cpp": "WHISPER_CPP",
        # Cloud BYOK speech providers. Shorthand examples:
        # `sarvam :: saaras-v4`, `openai :: gpt-4o-transcribe`.
        "sarvam": "SARVAM",
        "openai": "OPENAI",
        # Denoise models (RNNoise et al.) load via the ONNX runtime path.
        "rnnoise": "ONNX",
    }

    @classmethod
    def from_value(cls, value: str | dict[str, Any]) -> "ModelRef":
        """
        Create ModelRef from YAML value.

        Args:
            value: A string slug, a ``provider :: model[@rev]`` shorthand
                (schema v2), or a dict with an inline definition.
        """
        if isinstance(value, str):
            if "::" in value:
                provider_raw, _, model_part = value.partition("::")
                provider = provider_raw.strip().lower()
                model_id = model_part.strip()
                rev: str | None = None
                if "@" in model_id:
                    model_id, _, rev_raw = model_id.partition("@")
                    model_id = model_id.strip()
                    rev = rev_raw.strip() or None
                engine_str = cls._PROVIDER_ALIASES.get(provider)
                if engine_str is None:
                    raise ValueError(
                        f"Unknown ASR provider '{provider}'. Valid providers: "
                        + ", ".join(sorted(cls._PROVIDER_ALIASES))
                    )
                if not model_id:
                    raise ValueError(f"'{value}' is missing the model id after '::'")
                return cls.from_value(
                    {
                        "hf_model_id": model_id,
                        "engine": engine_str,
                        **({"version": rev} if rev else {}),
                    }
                )
            return cls(slug=value)
        elif isinstance(value, dict):
            # If the dict carries a slug (and no hf_model_id), treat as slug reference
            if "slug" in value and "hf_model_id" not in value and "model_id" not in value:
                return cls(slug=value["slug"])

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
                # Accepts `faster_whisper` / `faster-whisper`
                "FASTER_WHISPER": AiModelFormat.FASTER_WHISPER,
                "FASTER-WHISPER": AiModelFormat.FASTER_WHISPER,
                "OPTIMUM": AiModelFormat.ONNX_OPTIMUM,
                # Accepts the enum's own value (and the registry spelling) now
                # that unknown strings hard-error.
                "ONNX_OPTIMUM": AiModelFormat.ONNX_OPTIMUM,
                "ONNX-OPTIMUM": AiModelFormat.ONNX_OPTIMUM,
                "AZURE_SPEECH": AiModelFormat.AZURE_SPEECH,
                "AZURE": AiModelFormat.AZURE_SPEECH,
                "AZURE_FOUNDRY": AiModelFormat.AZURE_FOUNDRY,
                "AZURE-FOUNDRY": AiModelFormat.AZURE_FOUNDRY,
                "FOUNDRY": AiModelFormat.AZURE_FOUNDRY,
                "MAI": AiModelFormat.AZURE_FOUNDRY,
                "PARAKEET_CPP": AiModelFormat.PARAKEET_CPP,
                "PARAKEET-CPP": AiModelFormat.PARAKEET_CPP,
                "PARAKEET.CPP": AiModelFormat.PARAKEET_CPP,
                "WHISPER_CPP": AiModelFormat.WHISPER_CPP,
                "WHISPER-CPP": AiModelFormat.WHISPER_CPP,
                "WHISPER.CPP": AiModelFormat.WHISPER_CPP,
                "SARVAM": AiModelFormat.SARVAM,
                "OPENAI": AiModelFormat.OPENAI,
            }
            # Unknown engine strings are a hard error. The old silent
            # SAFETENSOR default turned a typo into a different engine that
            # failed obscurely at model-load time.
            engine_or_none = engine_mapping.get(engine_str)
            if engine_or_none is None:
                raise ValueError(
                    f"Unknown ASR engine '{value.get('engine')}'. Valid engines: "
                    + ", ".join(sorted({k.lower() for k in engine_mapping}))
                )
            engine = engine_or_none

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
    embedding: ModelRef | None = None  # Speaker embedding model (optional)
    segmentation: ModelRef | None = None  # Speaker segmentation model (optional)

    def get_all_refs(self) -> list[tuple[str, ModelRef]]:
        """Get all non-None model references with their role."""
        refs = [("asr", self.asr)]
        if self.vad:
            refs.append(("vad", self.vad))
        if self.denoise:
            refs.append(("denoise", self.denoise))
        if self.embedding:
            refs.append(("embedding", self.embedding))
        if self.segmentation:
            refs.append(("segmentation", self.segmentation))
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
        if self.embedding and self.embedding.slug:
            slugs.append(self.embedding.slug)
        if self.segmentation and self.segmentation.slug:
            slugs.append(self.segmentation.slug)
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
        if self.embedding and self.embedding.is_inline and self.embedding.inline:
            inline_models.append(("embedding", self.embedding.inline))
        if self.segmentation and self.segmentation.is_inline and self.segmentation.inline:
            inline_models.append(("segmentation", self.segmentation.inline))
        return inline_models


@dataclass
class VadConfig:
    """Voice Activity Detection configuration."""

    # TASK-977 (owner decision D-1) — OFF by default. Only the DEPRECATED `pipeline_id` YAML
    # path can reach this default: an agent-resolved session always STATES the flag on the
    # wire (`ResolvedAsrSpec.audio_front_end.vad.enabled` is required, no pydantic default).
    # Flipped so the legacy path cannot run a stage the gateway, the SYSTEM agent and the
    # browser SDK all declare off — one posture, not one per entry point.
    enabled: bool = False
    threshold: float = 0.6
    # 100 ms (was 250). A spoken "yes"/"no" is ~150-250 ms; at 250 ms the
    # whole word is discarded before reaching ASR. Production consensus
    # (LiveKit ships 50 ms) is 50-100 ms with the false-positive control left
    # to threshold + hysteresis, not duration gating.
    min_speech_duration_ms: int = 100
    min_silence_duration_ms: int = 100
    # 200 ms (was 30). Batch-only segment padding; Silero onsets are
    # structurally late by 30-100 ms and unvoiced tails fall below threshold —
    # faster-whisper ships speech_pad_ms=400 for transcription use.
    padding_ms: int = 200
    pre_speech_context_ms: int = 500
    force_emit_after_ms: int = 25000
    force_emit_lookback_ms: int = 1500
    force_emit_overlap_ms: int = 500


# Denoise data-flow scope (dual-path):
#   "vad_only" (default): the denoised signal gates VAD only; ASR consumes the
#     raw (resampled) audio. Medical-ASR evidence (arXiv 2512.17562): speech
#     enhancement before ASR degraded accuracy in 40/40 tested configurations.
#   "full": legacy behavior — ASR consumes the denoised audio.
VALID_DENOISE_SCOPES: list[str] = ["vad_only", "full"]

# Denoise engine selection (rnnoise = legacy default).
VALID_DENOISE_ENGINES: list[str] = ["rnnoise", "deepfilternet3"]

# Normalize processor selection (peak = legacy).
VALID_NORMALIZE_PROCESSORS: list[str] = ["peak", "rms"]


@dataclass
class DenoiseConfig:
    """Audio denoising configuration."""

    enabled: bool = False
    strength: float = 0.5
    scope: str = "vad_only"  # vad_only | full
    # Denoise engine selector. "rnnoise" (default, unchanged behavior) or
    # "deepfilternet3" (DeepFilterNet3, full-band 48kHz DNN).
    engine: str = "rnnoise"


@dataclass
class EndpointConfig:
    """Semantic end-of-utterance (endpointing) configuration.

    Content-driven end-of-turn detection that augments the fixed Silero-VAD
    silence offset on the realtime hot path. When ``enabled`` and the running
    hypothesis carries a reliable completion signal, the streaming preprocessor
    may cut the final EARLIER than the fixed ``VadConfig.min_silence_duration_ms``
    backstop (target 160–500 ms band), or capture a tail the timer would strand.

    Safety posture (default OFF): with ``enabled=False`` the preprocessor uses
    the exact fixed silence-offset behavior. When enabled, the endpointer is
    conservative — it only cuts on a confident, complete turn and otherwise
    falls through to the fixed backstop, so an incomplete utterance is never
    truncated. ``model_id`` is an OPTIONAL self-hosted turn-detector; empty means
    the model-free heuristic core only (no cloud dependency ever).
    """

    enabled: bool = False
    # Target-min EOU latency: trailing-silence floor (ms) before a semantic
    # early cut is allowed. Kept below the fixed backstop so a cut is "earlier".
    min_endpoint_silence_ms: int = 200
    # Target-max EOU latency band (ms) — informational cap; the fixed
    # VadConfig backstop remains the true upper bound.
    max_endpoint_silence_ms: int = 500
    # Minimum decision confidence to cut early (conservative default).
    confidence_threshold: float = 0.85
    # Minimum hypothesis word count — tiny fragments defer to the fixed timer.
    min_words: int = 3
    # OPTIONAL self-hosted turn/EOU model id; "" = model-free heuristic only.
    model_id: str = ""


@dataclass
class DiarizationConfig:
    """Speaker diarization configuration."""

    enabled: bool = False
    # Above this threshold = confident match
    high_threshold: float = 0.7
    # Below this threshold = confident new speaker
    low_threshold: float = 0.4
    # Maximum number of speakers (0 = unlimited)
    max_speakers: int = 2
    # Minimum segment duration (seconds) to register a new speaker
    min_segment_duration_s: float = 1.0
    # Silence padding (ms) added before/after each VAD speech segment
    segment_silence_padding_ms: int = 100
    # Minimum confidence to trigger reference update
    min_update_confidence: float = 0.8
    # On-demand segmentation for ambiguous zone
    enable_segmentation_refinement: bool = True
    # Rolling window size per speaker (number of recent embeddings to keep)
    max_embeddings_per_speaker: int = 8
    # TASK-887 — the cosine floor at which a segment may be labelled with an ENROLLED
    # voice profile (the gateway pushes the session's profiles; see `preseed.py`), and the
    # cross-sample consistency floor enrollment must clear. Below it the segment gets a
    # generic "Speaker N" label — a real clinician name is never attached on a weak match.
    # 0.6 is the value the retired platform key `stt.voiceProfile.minSimilarity` carried.
    match_threshold: float = 0.6
    # Streaming diarizer backend selector.
    #   "embedding"  -> the existing pyannote/wespeaker embedding-clustering path
    #                   (DEFAULT — preserves current behavior; batch stays here).
    #   "sortformer" -> the self-hosted NeMo Streaming Sortformer diarizer for the
    #                   live 2-speaker loop (frame-level clinician/patient turns),
    #                   used only once its weights are staged (see streaming_sortformer).
    backend: str = "embedding"
    # --- Streaming Sortformer knobs (used only when backend == "sortformer") ---
    # Pinned checkpoint (owner directive 2026-07-11): the v2.1 streaming Sortformer.
    # License = NVIDIA Open Model License (v2.1) — commercial use permitted; owner-
    # accepted (waived the in-app acceptance gate). NOTE: this differs from the plain
    # cc-by-4.0 of `...-v2`; it is NOT the cc-by-nc offline v1. Self-hosted only.
    sortformer_model_id: str = "nvidia/diar_streaming_sortformer_4spk-v2.1"
    # Pin the model by revision once staged ("Model pinned by revision").
    sortformer_revision: str | None = None
    # Per-frame speaker-activity probability threshold for turn extraction.
    sortformer_threshold: float = 0.5
    # Model frame cadence (~80 ms) — converts frame indices to timestamps.
    sortformer_frame_shift_s: float = 0.08


@dataclass
class DualCaptureConfig:
    """Per-pipeline dual audio capture.

    When ``enabled``, the streaming finalize path registers the audio WAVs
    already uploaded to object storage as ``Media`` + ``AudioRecording`` rows on
    the consultation. ``capture_raw`` selects the pre-filter (raw) audio under
    ``preprocessing``; ``capture_processed`` selects the post-filter audio under
    ``postprocessing``.
    """

    enabled: bool = False
    capture_raw: bool = False
    capture_processed: bool = False


@dataclass
class PreprocessingConfig:
    """Audio preprocessing configuration."""

    target_sample_rate: int = 16000
    normalize: bool = True
    # Normalize processor: peak (legacy) | rms.
    normalize_processor: str = "peak"
    # Resample declared as a stage; disabling is honored only when the input
    # is already VAD-compatible (runtime guards resample when Silero needs
    # 8/16 kHz).
    resample_enabled: bool = True
    vad: VadConfig = field(default_factory=VadConfig)
    denoise: DenoiseConfig = field(default_factory=DenoiseConfig)
    dual_capture: DualCaptureConfig = field(default_factory=DualCaptureConfig)
    # Semantic end-of-utterance config (default disabled); parsed from
    # `preprocessing.endpoint` since schema v2.
    endpoint: EndpointConfig = field(default_factory=EndpointConfig)
    # Declarative marker for the diarization feature-extraction stage
    # (executes inside the diarization track): True requires models.embedding;
    # None = not declared.
    diar_feature_extraction_enabled: bool | None = None


@dataclass
class InferenceConfig:
    """Model inference configuration."""

    batch_size: int = 16
    compute_type: str = "auto"  # auto, float16, float32, int8
    device: str = "auto"  # auto, cuda, cpu
    num_workers: int = 4
    beam_size: int = 5
    temperature: list[float] = field(default_factory=lambda: [0.0, 0.2, 0.4, 0.6, 0.8, 1.0])
    compression_ratio_threshold: float | None = 2.4
    logprob_threshold: float | None = -1.0
    no_speech_threshold: float | None = 0.6
    no_repeat_ngram_size: int = 3
    language: str | None = None  # None = auto-detect
    code_switching: bool = False  # Enable multilingual code-switching
    initial_prompt: str | None = None  # PromptTemplate UUID for Whisper conditioning
    # TASK-861 — the agent's LITERAL decoder prompt (ResolvedAsrSpec.instruction);
    # takes precedence over the template id above, which needs a DB read.
    initial_prompt_text: str | None = None
    # TASK-877 — ResolvedAsrSpec.decoding.vadFilter. The streaming path already
    # ran VAD in the preprocessor, so the default stays OFF; an agent that wants
    # the engine's own VAD gate (long-form batch audio, mostly) asks for it.
    vad_filter: bool = False
    # TASK-877 / owner decision #9 — ResolvedAsrSpec.decoding.{chunkLengthSec,
    # strideLengthSec}. TASK-880 deleted the platform keys these used to fall back to
    # (`stt.transcription.{chunkLengthS,strideLengthS}`), so these ARE the values: the
    # spec is the only source, and an agent that says nothing gets the engine defaults
    # below — the same numbers those keys carried, now declared where every other
    # engine default lives. Whisper's feature extractor truncates to a 30s context, so
    # 15s halves time-to-first-word at comparable accuracy; `[4, 2]` is the left/right
    # overlap that stops a word being cut at a chunk boundary.
    chunk_length_sec: float = 15.0
    stride_length_sec: tuple[int, int] = (4, 2)
    # TASK-880 — `ResolvedAsrSpec.models.asr.metadata.maxDecodeWindowSec`
    # (`AiModel._metadata.asr`). Longest audio fed to the engine in ONE decode;
    # longer utterances are split at silence troughs and stitched. `0.0` disables
    # the guard, which is the right answer for a model that declares no window —
    # this replaces the platform key `stt.whisperCpp.maxAudioSeconds`, which
    # applied ONE number to every engine on the box.
    max_decode_window_sec: float = 0.0
    # TASK-861 — agent hotwords (ResolvedAsrSpec.instruction.hotwords). Carried
    # for engines that accept them; not yet wired into every adapter.
    hotwords: list[str] = field(default_factory=list)
    # TASK-946 (OD-1) / TASK-937 R-4 — `ResolvedAsrSpec.decoding.hotwordsInPrompt`.
    # whisper.cpp has no hotword API, so the only way to bias it toward a term is to
    # list the terms in the `initial_prompt`. On the seeded ml-en fine-tune that append
    # is what turns an English consultation into Malayalam script (measured: 100 % Latin
    # with no prompt, 2 % with the priming prompt + agent prompt + these terms), so the
    # ENGINE DEFAULT is OFF and a model row that tolerates the append opts in. The terms
    # themselves are unaffected — `hotwords` above still feeds the lexicon stage.
    hotwords_in_prompt: bool = False
    prev_text_context_words: int = 50
    enable_prev_text_context: bool = True
    condition_on_prev_tokens: bool = False
    max_words_per_second: float = 1000.0
    max_segment_text_chars: int = 1200
    hallucination_rms_threshold: float = 0.01
    hallucination_short_word_count: int = 3
    # Opt-in streaming English gloss: after a final publishes, run a
    # low-priority task=translate pass on the same cached model and publish
    # a follow-up `type: gloss` result.
    streaming_english_gloss: bool = False


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
class SegmentMergeConfig:
    """Per-pipeline VAD segment merging.

    ``enabled=None`` inherits the global setting gate
    (``settings.segment_merge_gap_threshold_s > 0`` — the v1 behavior);
    True/False override it. ``gap_threshold_s``/``max_duration_s`` override
    the global values when set.
    """

    enabled: bool | None = None
    gap_threshold_s: float | None = None
    max_duration_s: float | None = None


@dataclass
class LexiconConfig:
    """TASK-935 — per-session clinical-vocabulary correction.

    ``terms`` is the resolved hotword list (``ResolvedAsrSpec.instruction.hotwords``),
    bound here by ``pipeline_spec_from_resolved`` rather than travelling twice on the
    wire: one list, two consumers (decoder prompt bias and this stage — OD-5 a).

    ``enabled`` is what the AGENT decided, already folded: when the spec omits the
    block, the gateway's silence means "ON exactly when there are terms", and that
    resolution happens where both halves are in hand. ``max_distance=None`` keeps
    :data:`stt.postprocessing.lexicon.DEFAULT_MAX_DISTANCE` — the dataclass never
    restates an engine default.
    """

    enabled: bool = False
    max_distance: float | None = None
    terms: list[str] = field(default_factory=list)

    @property
    def active(self) -> bool:
        """A stage with no terms is a no-op however it was configured."""
        return self.enabled and bool(self.terms)


@dataclass
class PostprocessingConfig:
    """Postprocessing configuration."""

    timestamps: TimestampConfig = field(default_factory=TimestampConfig)
    punctuation: PunctuationConfig = field(default_factory=PunctuationConfig)
    remove_disfluencies: bool = False
    lowercase: bool = False
    dual_capture: DualCaptureConfig = field(default_factory=DualCaptureConfig)
    segment_merge: SegmentMergeConfig = field(default_factory=SegmentMergeConfig)
    lexicon: LexiconConfig = field(default_factory=LexiconConfig)


# Valid values for streaming.commit_policy.
VALID_STREAMING_COMMIT_POLICIES: list[str] = ["none", "local_agreement_2"]

# Valid values for diarization.backend. "embedding" is the existing
# pyannote/wespeaker embedding-clustering path (default); "sortformer" routes
# the live 2-speaker loop through the self-hosted NeMo Streaming Sortformer.
VALID_DIARIZATION_BACKENDS: list[str] = ["embedding", "sortformer"]


@dataclass
class StreamingConfig:
    """Streaming-specific pipeline configuration.

    ``commit_policy`` gates the LocalAgreement-2 partial stabilizer:
    - ``"none"`` (default): partials publish unchanged, no ``stable_chars``.
    - ``"local_agreement_2"``: partials carry the additive ``stable_chars``
      field marking the committed (stable) prefix.

    TASK-877 — ``partial_interval_s`` and ``max_utterance_sec`` carry
    ``ResolvedAsrSpec.streaming.{partialIntervalMs,maxUtteranceSec}`` for the
    session. ``None`` means the agent said nothing, so the preprocessor's own
    constructor default stands: the spec carries what the agent SAID and never
    restates an engine default.

    TASK-880 — ``partial_window_s`` follows the same rule, but its source is the ASR
    MODEL row (``metadata.partialWindowSec``) rather than the agent: the right tail
    length is a property of the engine's force-emit window, not of a clinic's policy.
    """

    commit_policy: str = "none"
    partial_interval_s: float | None = None
    max_utterance_sec: int | None = None
    # TASK-880 — `ResolvedAsrSpec.models.asr.metadata.partialWindowSec`. The tail of
    # the live utterance decoded for PARTIALs, which should match the ASR row's
    # force-emit window so the last partial and the final decode the SAME audio.
    # `None` = the row declared none, so `StreamingPreprocessor`'s own default stands.
    partial_window_s: float | None = None


@dataclass
class PipelineSpec:
    """Full pipeline specification parsed from YAML."""

    version: str
    models: ModelRefs
    preprocessing: PreprocessingConfig
    inference: InferenceConfig
    postprocessing: PostprocessingConfig
    diarization: DiarizationConfig = field(default_factory=DiarizationConfig)
    streaming: StreamingConfig = field(default_factory=StreamingConfig)

    def __post_init__(self) -> None:
        """Inherit inference-level defaults into inline models that lack them."""
        fallback_ct = self.inference.compute_type
        if not fallback_ct or fallback_ct == "auto":
            return
        for _role, inline_def in self.models.get_inline_models():
            if inline_def.compute_type is None:
                inline_def.compute_type = fallback_ct


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
    device: str | None = None  # Override device (auto, cuda, cpu, mps)
    attn_implementation: str | None = None  # "flash_attention_2", "sdpa", or None (default)
    #: TASK-944 (B2) — ``AiModel.libraryName``, the Hugging Face ``library_name``
    #: facet. THE loader-selection field since TASK-860 ("Artifact format —
    #: descriptive only ... Loader selection is `libraryName`",
    #: ``packages/database/src/prisma/db_main/ai-model.prisma``). ``None`` on the
    #: paths that cannot declare one — an inline model definition, or a spec built
    #: by a gateway that predates the wire field — where selection falls back to
    #: ``format`` exactly as it did before.
    library_name: str | None = None
    #: TASK-958 — the ``provider_overrides`` key this model's credential arrives under
    #: (a tenant connection's ``slug``, or the provider id for a platform row) and the
    #: ``AiProviderConnection`` id the usage ledger attributes its spend to. Both
    #: ``None`` on every path that cannot declare one — an inline model definition, or a
    #: spec built by a gateway that predates the fields — where the loader falls back to
    #: its declared ``override_key`` exactly as it did before.
    connection_key: str | None = None
    connection_id: str | None = None

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
