"""YAML parser for pipeline configurations."""

import logging
import uuid as _uuid_mod
from typing import Any

import yaml

from .dto import (
    VALID_CT2_COMPUTE_TYPES,
    VALID_ONNX_QUANTIZATIONS,
    VALID_PARAKEET_V3_LANGUAGES,
    VALID_STREAMING_COMMIT_POLICIES,
    AiModelFormat,
    DenoiseConfig,
    DiarizationConfig,
    DualCaptureConfig,
    InferenceConfig,
    ModelRef,
    ModelRefs,
    PipelineSpec,
    PostprocessingConfig,
    PreprocessingConfig,
    PunctuationConfig,
    StreamingConfig,
    TimestampConfig,
    VadConfig,
    ValidationResult,
    is_valid_language_code,
    is_valid_language_for_engine,
)

logger = logging.getLogger(__name__)


class PipelineYamlParser:
    """
    Parse and validate pipeline YAML configuration.

    Supported versions:
    - 1.0: Original format with slug-only model references
    - 1.1: Enhanced format with inline model definitions (hf_model_id + engine)
    """

    SUPPORTED_VERSIONS = ["1.0", "1.1"]

    # Recognised top-level pipeline config sections. Unknown keys are warned
    # about (not silently dropped) so future intent-only keys don't no-op.
    KNOWN_TOP_LEVEL_KEYS = frozenset(
        {
            "version",
            "models",
            "preprocessing",
            "inference",
            "postprocessing",
            "diarization",
            "streaming",
        }
    )

    def parse(self, yaml_content: str) -> PipelineSpec:
        """
        Parse YAML string to PipelineSpec.

        Args:
            yaml_content: Raw YAML configuration string

        Returns:
            Parsed PipelineSpec

        Raises:
            ValueError: If YAML is invalid or missing required fields
        """
        try:
            data = yaml.safe_load(yaml_content)
        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML syntax: {e}") from e

        if not isinstance(data, dict):
            raise ValueError("YAML must be a dictionary/object")

        # Hardening: warn (don't silently drop) unknown top-level sections so
        # future intent-only keys surface instead of no-op'ing.
        unknown_keys = sorted(str(k) for k in data if k not in self.KNOWN_TOP_LEVEL_KEYS)
        if unknown_keys:
            logger.warning(
                "Unknown top-level pipeline config key(s) ignored: %s. Known keys: %s",
                ", ".join(unknown_keys),
                ", ".join(sorted(self.KNOWN_TOP_LEVEL_KEYS)),
            )

        # Parse version
        version = str(data.get("version", "1.0"))

        # Parse models (required)
        models_data = data.get("models")
        if not models_data:
            raise ValueError("Missing required 'models' section")

        models = self._parse_models(models_data)

        # Parse preprocessing (optional, use defaults)
        preprocessing_data = data.get("preprocessing", {})
        preprocessing = self._parse_preprocessing(preprocessing_data)

        # Parse inference (optional, use defaults)
        inference_data = data.get("inference", {})
        inference = self._parse_inference(inference_data)

        # Parse postprocessing (optional, use defaults)
        postprocessing_data = data.get("postprocessing", {})
        postprocessing = self._parse_postprocessing(postprocessing_data)

        # Parse diarization (optional, use defaults)
        diarization_data = data.get("diarization", {})
        diarization = self._parse_diarization(diarization_data)

        # Parse streaming (optional, use defaults) — TASK-351 P1-1
        streaming_data = data.get("streaming", {})
        streaming = self._parse_streaming(streaming_data)

        return PipelineSpec(
            version=version,
            models=models,
            preprocessing=preprocessing,
            inference=inference,
            postprocessing=postprocessing,
            diarization=diarization,
            streaming=streaming,
        )

    def validate(self, spec: PipelineSpec) -> ValidationResult:
        """
        Validate pipeline specification.

        Args:
            spec: Parsed pipeline specification

        Returns:
            ValidationResult with any errors found
        """
        result = ValidationResult(valid=True)

        # Version validation
        if spec.version not in self.SUPPORTED_VERSIONS:
            result.add_error(
                "version",
                f"Unsupported version '{spec.version}'. Supported: {self.SUPPORTED_VERSIONS}",
            )

        # Models validation - ASR is required
        asr_ref = spec.models.asr
        if asr_ref.is_inline and asr_ref.inline:
            # Validate inline model definition - check fields first for specific errors
            if not asr_ref.inline.hf_model_id or not asr_ref.inline.hf_model_id.strip():
                result.add_error(
                    "models.asr.hf_model_id",
                    "HuggingFace model ID is required for inline definition",
                )
            if not asr_ref.inline.engine:
                result.add_error("models.asr.engine", "Engine is required for inline definition")
        elif asr_ref.slug is not None:
            # Validate slug reference
            if not asr_ref.slug or not asr_ref.slug.strip():
                result.add_error("models.asr", "ASR model slug cannot be empty")
        else:
            # Neither inline nor slug defined
            result.add_error("models.asr", "ASR model is required")

        # Validate VAD inline model if present
        if spec.models.vad and spec.models.vad.is_inline and spec.models.vad.inline:
            if not spec.models.vad.inline.hf_model_id:
                result.add_error(
                    "models.vad.hf_model_id",
                    "HuggingFace model ID is required for inline definition",
                )

        # Validate denoise inline model if present
        if spec.models.denoise and spec.models.denoise.is_inline and spec.models.denoise.inline:
            if not spec.models.denoise.inline.hf_model_id:
                result.add_error(
                    "models.denoise.hf_model_id",
                    "HuggingFace model ID is required for inline definition",
                )

        # Validate embedding inline model if present
        if (
            spec.models.embedding
            and spec.models.embedding.is_inline
            and spec.models.embedding.inline
        ):
            if not spec.models.embedding.inline.hf_model_id:
                result.add_error(
                    "models.embedding.hf_model_id",
                    "HuggingFace model ID is required for inline definition",
                )

        # Validate quantization values for all inline models
        for role, model_ref in spec.models.get_all_refs():
            if model_ref.is_inline and model_ref.inline and model_ref.inline.quantization:
                q = model_ref.inline.quantization
                if q not in VALID_ONNX_QUANTIZATIONS:
                    result.add_error(
                        f"models.{role}.quantization",
                        f"Invalid quantization '{q}'. "
                        f"Valid values: {', '.join(VALID_ONNX_QUANTIZATIONS)}",
                    )

        # TASK-351 P1-2 — FASTER_WHISPER compute-type compatibility:
        # CTranslate2 accepts a wider/different set than the generic engines.
        for role, model_ref in spec.models.get_all_refs():
            if (
                model_ref.is_inline
                and model_ref.inline
                and model_ref.inline.engine == AiModelFormat.FASTER_WHISPER
                and model_ref.inline.compute_type
            ):
                ct = model_ref.inline.compute_type
                if ct not in VALID_CT2_COMPUTE_TYPES:
                    result.add_error(
                        f"models.{role}.compute_type",
                        f"Invalid CTranslate2 compute_type '{ct}' for "
                        f"engine FASTER_WHISPER. "
                        f"Valid values: {', '.join(VALID_CT2_COMPUTE_TYPES)}",
                    )

        # Preprocessing validation
        if spec.preprocessing.vad.threshold < 0 or spec.preprocessing.vad.threshold > 1:
            result.add_error("preprocessing.vad.threshold", "VAD threshold must be between 0 and 1")

        if spec.preprocessing.target_sample_rate not in [8000, 16000, 22050, 44100, 48000]:
            result.add_error(
                "preprocessing.target_sample_rate",
                "Sample rate must be one of: 8000, 16000, 22050, 44100, 48000",
            )

        # Inference validation
        if spec.inference.batch_size < 1 or spec.inference.batch_size > 64:
            result.add_error("inference.batch_size", "Batch size must be between 1 and 64")

        if spec.inference.compute_type not in ["float16", "float32", "int8", "auto"]:
            result.add_error(
                "inference.compute_type",
                "Compute type must be: float16, float32, int8, or auto",
            )

        if spec.inference.device not in ["auto", "cuda", "cpu", "mps"]:
            result.add_error("inference.device", "Device must be: auto, cuda, cpu, or mps")

        if spec.inference.beam_size < 1 or spec.inference.beam_size > 10:
            result.add_error("inference.beam_size", "Beam size must be between 1 and 10")

        temps = spec.inference.temperature
        if not isinstance(temps, (list, tuple)) or len(temps) == 0:
            result.add_error(
                "inference.temperature",
                "Temperature must be a non-empty list of floats (or a scalar).",
            )
        else:
            for idx, t in enumerate(temps):
                try:
                    t_val = float(t)
                except (TypeError, ValueError):
                    result.add_error(
                        f"inference.temperature[{idx}]",
                        f"Temperature value must be numeric, got {t!r}",
                    )
                    continue
                if t_val < 0 or t_val > 2:
                    result.add_error(
                        f"inference.temperature[{idx}]",
                        "Temperature must be between 0 and 2",
                    )

        if spec.inference.compression_ratio_threshold is not None:
            if spec.inference.compression_ratio_threshold <= 0:
                result.add_error(
                    "inference.compression_ratio_threshold",
                    "compression_ratio_threshold must be > 0 when set",
                )

        if spec.inference.logprob_threshold is not None:
            if spec.inference.logprob_threshold > 0:
                result.add_error(
                    "inference.logprob_threshold",
                    "logprob_threshold must be <= 0 when set (log-probabilities are non-positive)",
                )

        if spec.inference.no_speech_threshold is not None:
            if (
                spec.inference.no_speech_threshold < 0
                or spec.inference.no_speech_threshold > 1
            ):
                result.add_error(
                    "inference.no_speech_threshold",
                    "no_speech_threshold must be between 0 and 1 when set",
                )

        if spec.inference.no_repeat_ngram_size < 0 or spec.inference.no_repeat_ngram_size > 10:
            result.add_error(
                "inference.no_repeat_ngram_size",
                "no_repeat_ngram_size must be between 0 and 10 (0 disables)",
            )

        # Language code validation
        if spec.inference.language is not None:
            if not is_valid_language_code(spec.inference.language):
                result.add_error(
                    "inference.language",
                    f"Unrecognised language code '{spec.inference.language}'. "
                    f"Use an ISO 639-1 code (e.g. 'en', 'ml') or BCP-47 tag (e.g. 'en-US').",
                )

        # TASK-351 P2-1 — code_switching with a fixed language means PINNED
        # matrix language with code-switching enabled (deliberate semantics
        # change: the earlier warning advised `language: null`; the language
        # is now passed through to the engine). language: null + CS keeps
        # auto-LID.
        if spec.inference.code_switching and spec.inference.language is not None:
            logger.info(
                "code_switching enabled with pinned matrix language '%s' — "
                "the language is passed to the engine; code-switched segments "
                "remain in their spoken language.",
                spec.inference.language,
            )

        # TASK-351 P2-1 — hard guard: the NEMO (Parakeet) engine only
        # supports the Parakeet-v3 language set (e.g. 'ml' is Whisper-only).
        if (
            spec.inference.language is not None
            and asr_ref.is_inline
            and asr_ref.inline
            and asr_ref.inline.engine == AiModelFormat.NEMO
            and not is_valid_language_for_engine(
                spec.inference.language, AiModelFormat.NEMO
            )
        ):
            result.add_error(
                "inference.language",
                f"Language '{spec.inference.language}' is not supported by the "
                f"NEMO (Parakeet) engine. Supported: "
                f"{', '.join(sorted(VALID_PARAKEET_V3_LANGUAGES))}",
            )

        # initial_prompt must be a valid UUID if present
        if spec.inference.initial_prompt is not None:
            try:
                _uuid_mod.UUID(spec.inference.initial_prompt)
            except (ValueError, AttributeError):
                result.add_error(
                    "inference.initial_prompt",
                    f"initial_prompt must be a valid UUID, got '{spec.inference.initial_prompt}'",
                )

        # Streaming validation (TASK-351 P1-1)
        if spec.streaming.commit_policy not in VALID_STREAMING_COMMIT_POLICIES:
            result.add_error(
                "streaming.commit_policy",
                f"Invalid commit_policy '{spec.streaming.commit_policy}'. "
                f"Valid values: {', '.join(VALID_STREAMING_COMMIT_POLICIES)}",
            )

        # Diarization validation
        if spec.diarization.low_threshold >= spec.diarization.high_threshold:
            result.add_error(
                "diarization.low_threshold",
                "low_threshold must be less than high_threshold",
            )
        if spec.diarization.high_threshold < 0 or spec.diarization.high_threshold > 1:
            result.add_error(
                "diarization.high_threshold",
                "high_threshold must be between 0 and 1",
            )
        if spec.diarization.low_threshold < 0 or spec.diarization.low_threshold > 1:
            result.add_error(
                "diarization.low_threshold",
                "low_threshold must be between 0 and 1",
            )
        if spec.diarization.max_speakers < 0:
            result.add_error(
                "diarization.max_speakers",
                "max_speakers must be non-negative",
            )
        if spec.diarization.min_segment_duration_s < 0:
            result.add_error(
                "diarization.min_segment_duration_s",
                "Minimum segment duration must be non-negative",
            )

        return result

    def extract_model_slugs(self, spec: PipelineSpec) -> list[str]:
        """
        Extract all model slugs referenced in configuration.

        Args:
            spec: Pipeline specification

        Returns:
            List of model slugs
        """
        return spec.models.get_all_slugs()

    def _parse_models(self, data: dict[str, Any]) -> ModelRefs:
        """
        Parse models section.

        Supports both formats:
        - String slug: asr: "whisper-large-v3"
        - Inline definition:
            asr:
              hf_model_id: "onnx-community/whisper-large-v3-turbo"
              engine: "onnx"
        """
        asr_value = data.get("asr", "")
        vad_value = data.get("vad")
        denoise_value = data.get("denoise")
        embedding_value = data.get("embedding")
        segmentation_value = data.get("segmentation")

        # Parse ASR model (required)
        asr_ref = ModelRef.from_value(asr_value) if asr_value else ModelRef(slug="")

        # Parse VAD model (optional)
        vad_ref = None
        if vad_value:
            vad_ref = ModelRef.from_value(vad_value)

        # Parse denoise model (optional)
        denoise_ref = None
        if denoise_value:
            denoise_ref = ModelRef.from_value(denoise_value)

        # Parse embedding model (optional)
        embedding_ref = None
        if embedding_value:
            embedding_ref = ModelRef.from_value(embedding_value)

        # Parse segmentation model (optional)
        segmentation_ref = None
        if segmentation_value:
            segmentation_ref = ModelRef.from_value(segmentation_value)

        return ModelRefs(
            asr=asr_ref,
            vad=vad_ref,
            denoise=denoise_ref,
            embedding=embedding_ref,
            segmentation=segmentation_ref,
        )

    def _parse_preprocessing(self, data: dict[str, Any]) -> PreprocessingConfig:
        """Parse preprocessing section."""
        vad_data = data.get("vad", {})
        vad = VadConfig(
            enabled=vad_data.get("enabled", True),
            threshold=float(vad_data.get("threshold", 0.6)),
            min_speech_duration_ms=int(vad_data.get("min_speech_duration_ms", 350)),
            min_silence_duration_ms=int(vad_data.get("min_silence_duration_ms", 100)),
            padding_ms=int(vad_data.get("padding_ms", 30)),
            pre_speech_context_ms=int(vad_data.get("pre_speech_context_ms", 500)),
            force_emit_after_ms=int(vad_data.get("force_emit_after_ms", 25000)),
            force_emit_lookback_ms=int(vad_data.get("force_emit_lookback_ms", 1500)),
            force_emit_overlap_ms=int(vad_data.get("force_emit_overlap_ms", 500)),
        )

        denoise_data = data.get("denoise", {})
        denoise = DenoiseConfig(
            enabled=denoise_data.get("enabled", False),
            strength=float(denoise_data.get("strength", 0.5)),
        )

        dual_capture_data = data.get("dual_capture") or {}
        dual_capture = DualCaptureConfig(
            enabled=bool(dual_capture_data.get("enabled", False)),
            capture_raw=bool(dual_capture_data.get("capture_raw", False)),
        )

        return PreprocessingConfig(
            target_sample_rate=int(data.get("target_sample_rate", 16000)),
            normalize=data.get("normalize", True),
            vad=vad,
            denoise=denoise,
            dual_capture=dual_capture,
        )

    def _parse_inference(self, data: dict[str, Any]) -> InferenceConfig:
        """Parse inference section."""
        initial_prompt = data.get("initial_prompt")
        if initial_prompt is not None:
            initial_prompt = str(initial_prompt)

        temperature = self._parse_temperature(data.get("temperature"))

        kwargs: dict[str, Any] = {
            "batch_size": int(data.get("batch_size", 16)),
            "compute_type": str(data.get("compute_type", "auto")),
            "device": str(data.get("device", "auto")),
            "num_workers": int(data.get("num_workers", 4)),
            "beam_size": int(data.get("beam_size", 5)),
            "language": data.get("language"),
            "code_switching": bool(data.get("code_switching", False)),
            "initial_prompt": initial_prompt,
        }

        if temperature is not None:
            kwargs["temperature"] = temperature

        if "no_repeat_ngram_size" in data and data["no_repeat_ngram_size"] is not None:
            kwargs["no_repeat_ngram_size"] = int(data["no_repeat_ngram_size"])

        if "compression_ratio_threshold" in data:
            value = data["compression_ratio_threshold"]
            kwargs["compression_ratio_threshold"] = (
                None if value is None else float(value)
            )

        if "logprob_threshold" in data:
            value = data["logprob_threshold"]
            kwargs["logprob_threshold"] = None if value is None else float(value)

        if "no_speech_threshold" in data:
            value = data["no_speech_threshold"]
            kwargs["no_speech_threshold"] = None if value is None else float(value)

        if "condition_on_prev_tokens" in data:
            kwargs["condition_on_prev_tokens"] = bool(data["condition_on_prev_tokens"])

        if "prev_text_context_words" in data and data["prev_text_context_words"] is not None:
            kwargs["prev_text_context_words"] = int(data["prev_text_context_words"])

        if "enable_prev_text_context" in data:
            kwargs["enable_prev_text_context"] = bool(data["enable_prev_text_context"])

        if "max_words_per_second" in data and data["max_words_per_second"] is not None:
            kwargs["max_words_per_second"] = float(data["max_words_per_second"])

        if "max_segment_text_chars" in data and data["max_segment_text_chars"] is not None:
            kwargs["max_segment_text_chars"] = int(data["max_segment_text_chars"])

        if "hallucination_rms_threshold" in data and data["hallucination_rms_threshold"] is not None:
            kwargs["hallucination_rms_threshold"] = float(data["hallucination_rms_threshold"])

        if "hallucination_short_word_count" in data and data["hallucination_short_word_count"] is not None:
            kwargs["hallucination_short_word_count"] = int(data["hallucination_short_word_count"])

        # TASK-351 P2-3 — opt-in streaming English gloss flag.
        if "streaming_english_gloss" in data:
            kwargs["streaming_english_gloss"] = bool(data["streaming_english_gloss"])

        return InferenceConfig(**kwargs)

    @staticmethod
    def _parse_temperature(value: Any) -> list[float] | None:
        """Normalise YAML ``temperature`` (scalar, list, null, or missing).

        Returns ``None`` when the key is omitted so the dataclass default is
        used; returns ``list[float]`` otherwise (scalar → one-element list).
        Invalid entries raise ``ValueError`` so validation can surface them.
        """
        if value is None:
            return None
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return [float(value)]
        if isinstance(value, (list, tuple)):
            return [float(v) for v in value]
        raise ValueError(
            f"inference.temperature must be a number or list of numbers, got {type(value).__name__}"
        )

    def _parse_postprocessing(self, data: dict[str, Any]) -> PostprocessingConfig:
        """Parse postprocessing section."""
        timestamps_data = data.get("timestamps", {})
        timestamps = TimestampConfig(
            word_timestamps=timestamps_data.get("word_timestamps", True),
            sentence_timestamps=timestamps_data.get("sentence_timestamps", True),
        )

        punctuation_data = data.get("punctuation", {})
        # Handle shorthand: ``punctuation: true`` (bool) vs full dict form
        if isinstance(punctuation_data, bool):
            punctuation_data = {"enabled": punctuation_data}
        punctuation = PunctuationConfig(
            enabled=punctuation_data.get("enabled", True),
            model=punctuation_data.get("model"),
        )

        dual_capture_data = data.get("dual_capture") or {}
        dual_capture = DualCaptureConfig(
            enabled=bool(dual_capture_data.get("enabled", False)),
            capture_processed=bool(dual_capture_data.get("capture_processed", False)),
        )

        return PostprocessingConfig(
            timestamps=timestamps,
            punctuation=punctuation,
            remove_disfluencies=data.get("remove_disfluencies", False),
            lowercase=data.get("lowercase", False),
            dual_capture=dual_capture,
        )

    def _parse_streaming(self, data: dict[str, Any]) -> StreamingConfig:
        """Parse streaming section (TASK-351 P1-1)."""
        if not isinstance(data, dict):
            data = {}
        return StreamingConfig(
            commit_policy=str(data.get("commit_policy", "none")),
        )

    def _parse_diarization(self, data: dict[str, Any]) -> DiarizationConfig:
        """Parse diarization section."""
        return DiarizationConfig(
            enabled=data.get("enabled", False),
            high_threshold=float(data.get("high_threshold", 0.7)),
            low_threshold=float(data.get("low_threshold", 0.4)),
            max_speakers=int(data.get("max_speakers", 2)),
            min_segment_duration_s=float(data.get("min_segment_duration_s", 1.0)),
            segment_silence_padding_ms=int(data.get("segment_silence_padding_ms", 100)),
            min_update_confidence=float(data.get("min_update_confidence", 0.8)),
            enable_segmentation_refinement=data.get("enable_segmentation_refinement", True),
        )


# Singleton instance
_parser: PipelineYamlParser | None = None


def get_yaml_parser() -> PipelineYamlParser:
    """Get singleton YAML parser instance."""
    global _parser
    if _parser is None:
        _parser = PipelineYamlParser()
    return _parser
