"""Azure Cognitive Services Speech loader (cloud-based ASR engine).

Unlike local model loaders (ONNX, HuggingFace, NeMo), this loader does NOT
download or cache a model file.  Instead it validates Azure credentials and
produces a lightweight ``LoadedModel`` whose ``.model`` field holds a reusable,
thread-safe ``azure.cognitiveservices.speech.SpeechConfig`` instance.

The actual transcription is performed by the inference path in
``BatchTranscriptionService._run_azure_speech_inference``.
"""

import logging

from azure.cognitiveservices.speech import (
    OutputFormat,
    SpeechConfig,
)

from ..core.config.settings import get_settings
from ..core.exceptions import CloudASRAuthError
from ..pipeline.dto import AiModelConfig, AiModelFormat
from .base_loader import BaseModelLoader, LoadedModel

logger = logging.getLogger(__name__)

# BCP-47 language codes accepted by Azure Speech.
# Keys are short / common aliases; values are what Azure expects.
_LANGUAGE_ALIASES: dict[str, str] = {
    "en": "en-US",
    "ml": "ml-IN",
    "hi": "hi-IN",
    "ta": "ta-IN",
    "te": "te-IN",
    "kn": "kn-IN",
    "ar": "ar-SA",
    "fr": "fr-FR",
    "de": "de-DE",
    "es": "es-ES",
    "pt": "pt-BR",
    "ja": "ja-JP",
    "ko": "ko-KR",
    "zh": "zh-CN",
}


def normalize_language_for_azure(language: str | None) -> str:
    """Convert a language hint to a BCP-47 tag Azure Speech understands.

    Examples:
        >>> normalize_language_for_azure("en")
        'en-US'
        >>> normalize_language_for_azure("ml-IN")
        'ml-IN'
        >>> normalize_language_for_azure(None)
        'en-US'
    """
    if not language:
        return "en-US"
    # Already in BCP-47 form (contains a dash)?
    if "-" in language:
        return language
    return _LANGUAGE_ALIASES.get(language.lower(), language)


class AzureSpeechLoader(BaseModelLoader):
    """Loader for Azure Cognitive Services Speech (cloud API).

    This loader:
    * validates that Azure credentials are available,
    * creates a ``SpeechConfig`` object (cheap, reusable), and
    * wraps it in a ``LoadedModel`` so it participates in the same cache
      and lifecycle as local models.

    No model files are downloaded — ``estimate_memory`` returns 0.
    """

    @property
    def supported_formats(self) -> list[AiModelFormat]:
        return [AiModelFormat.AZURE_SPEECH]

    async def load(
        self,
        model_config: AiModelConfig,
        provider_overrides: dict[str, object] | None = None,
    ) -> LoadedModel:
        """Validate credentials and return a ``SpeechConfig`` handle.

        Args:
            model_config: Model configuration (from DB or inline YAML).
            provider_overrides: Optional per-tenant credential map (gateway
                wire shape). The ``azure-speech`` entry (``api_key``/``region``/
                ``endpoint``), when present, takes precedence over the inline
                config and env credentials (TASK-567 BYOK). Env fallback
                preserved.

        Returns:
            ``LoadedModel`` with ``model`` set to a ``SpeechConfig``.

        Raises:
            CloudASRAuthError: If credentials are missing or invalid.
        """
        settings = get_settings()

        override = None
        if provider_overrides:
            entry = provider_overrides.get("azure-speech")
            if isinstance(entry, dict) and entry:
                override = entry

        override_key = override.get("api_key") if override else None
        override_region = (
            (override.get("region") or override.get("endpoint")) if override else None
        )

        # Resolve credentials: per-tenant override > inline config > env settings
        speech_key = (
            override_key
            or (
                model_config.compute_type  # Re-purpose compute_type field for key
                if model_config.compute_type and model_config.compute_type.startswith("key:")
                else None
            )
            or (settings.azure_speech_key.get_secret_value() if settings.azure_speech_key else None)
        )

        speech_region = (
            override_region
            or self._resolve_region(model_config)
            or settings.azure_speech_region
        )

        if not speech_key or not speech_region:
            raise CloudASRAuthError(
                "Azure Speech credentials not configured. "
                "Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION environment variables, "
                "or pass them in the pipeline configuration.",
                details={
                    "has_key": bool(speech_key),
                    "has_region": bool(speech_region),
                },
            )

        # Create reusable, thread-safe SpeechConfig
        speech_config = SpeechConfig(subscription=speech_key, region=speech_region)

        # Enable detailed results by default (word-level timestamps, NBest)
        speech_config.output_format = OutputFormat.Detailed
        speech_config.request_word_level_timestamps()

        logger.info(
            "Azure Speech config created for region=%s (model_slug=%s)",
            speech_region,
            model_config.slug,
        )

        return LoadedModel(
            model_id=model_config.id,
            model_slug=model_config.slug,
            model=speech_config,
            tokenizer=None,
            processor=None,
            feature_extractor=None,
            format=AiModelFormat.AZURE_SPEECH,
            memory_mb=0,  # No local memory footprint
            device="cloud",
            extra={
                "region": speech_region,
                "is_cloud": True,
                "provider": "azure_speech",
            },
        )

    async def unload(self, loaded_model: LoadedModel) -> None:
        """Release the ``SpeechConfig`` handle.

        ``SpeechConfig`` has no heavyweight resources to free, so this
        is effectively a no-op.
        """
        if loaded_model.model is not None:
            loaded_model.model = None
        logger.info("Azure Speech handle released: %s", loaded_model.model_slug)

    def estimate_memory(self, model_config: AiModelConfig) -> int:
        """Cloud engine uses negligible local memory."""
        return 0

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_region(model_config: AiModelConfig) -> str | None:
        """Extract Azure region from model config metadata.

        Supports multiple ways to specify the region:
        * ``source_uri`` set to the region string (e.g. ``"eastus"``)
        * ``source_revision`` set to the region string
        """
        # source_uri may hold the region for cloud engines
        uri = model_config.source_uri or ""
        if uri and "/" not in uri and "." not in uri:
            # Looks like a bare region string (e.g. "eastus"), not a URL/ID
            return uri
        return model_config.source_revision
