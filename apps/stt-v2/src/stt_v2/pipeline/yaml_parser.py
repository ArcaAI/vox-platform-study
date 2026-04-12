"""YAML parser for pipeline configurations."""

import logging
import uuid as _uuid_mod
from typing import Any

import yaml

from .dto import (
    VALID_ONNX_QUANTIZATIONS,
    DenoiseConfig,
    DiarizationConfig,
    InferenceConfig,
    ModelRef,
    ModelRefs,
    PipelineSpec,
    PostprocessingConfig,
    PreprocessingConfig,
    PunctuationConfig,
    TimestampConfig,
    VadConfig,
    ValidationResult,
    is_valid_language_code,
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

        return PipelineSpec(
            version=version,
            models=models,
            preprocessing=preprocessing,
            inference=inference,
            postprocessing=postprocessing,
            diarization=diarization,
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

        if spec.inference.temperature < 0 or spec.inference.temperature > 2:
            result.add_error("inference.temperature", "Temperature must be between 0 and 2")

        # Language code validation
        if spec.inference.language is not None:
            if not is_valid_language_code(spec.inference.language):
                result.add_error(
                    "inference.language",
                    f"Unrecognised language code '{spec.inference.language}'. "
                    f"Use an ISO 639-1 code (e.g. 'en', 'ml') or BCP-47 tag (e.g. 'en-US').",
                )

        # Code-switching + language hint advisory
        if spec.inference.code_switching and spec.inference.language is not None:
            logger.warning(
                "code_switching is enabled together with a fixed language '%s'. "
                "For best results, set language to null (auto-detect) when "
                "code-switching is enabled.",
                spec.inference.language,
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
        )

        denoise_data = data.get("denoise", {})
        denoise = DenoiseConfig(
            enabled=denoise_data.get("enabled", False),
            strength=float(denoise_data.get("strength", 0.5)),
        )

        return PreprocessingConfig(
            target_sample_rate=int(data.get("target_sample_rate", 16000)),
            normalize=data.get("normalize", True),
            vad=vad,
            denoise=denoise,
        )

    def _parse_inference(self, data: dict[str, Any]) -> InferenceConfig:
        """Parse inference section."""
        initial_prompt = data.get("initial_prompt")
        if initial_prompt is not None:
            initial_prompt = str(initial_prompt)
        return InferenceConfig(
            batch_size=int(data.get("batch_size", 16)),
            compute_type=str(data.get("compute_type", "auto")),
            device=str(data.get("device", "auto")),
            num_workers=int(data.get("num_workers", 4)),
            beam_size=int(data.get("beam_size", 5)),
            temperature=float(data.get("temperature", 0.0)),
            language=data.get("language"),
            code_switching=bool(data.get("code_switching", False)),
            initial_prompt=initial_prompt,
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

        return PostprocessingConfig(
            timestamps=timestamps,
            punctuation=punctuation,
            remove_disfluencies=data.get("remove_disfluencies", False),
            lowercase=data.get("lowercase", False),
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
            min_update_confidence=float(data.get("min_update_confidence", data.get("ema_min_confidence", 0.8))),
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
