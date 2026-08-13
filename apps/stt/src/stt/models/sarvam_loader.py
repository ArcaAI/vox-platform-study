"""Sarvam AI speech-to-text loader (cloud REST ASR engine).

Like the Azure Speech loader this downloads no weights: it resolves
the API key (per-tenant override first, then ``SARVAM_API_KEY`` env) and returns
a lightweight ``LoadedModel`` whose ``.model`` is a :class:`CloudRestConfig`.
Actual transcription is performed by ``streaming/sarvam_asr.py`` (per-utterance,
streaming) and ``BatchTranscriptionService._run_sarvam_inference`` (batch).

Security: the key is never logged. Only region-free, non-secret fields
(base_url, model, slug) appear in log lines.
"""

import logging

from pydantic import SecretStr

from ..core.config.settings import get_settings
from ..core.exceptions import CloudASRAuthError
from ..pipeline.dto import AiModelConfig, AiModelFormat
from .base_loader import BaseModelLoader, LoadedModel
from .cloud_asr import CloudRestConfig, resolve_override_key

logger = logging.getLogger(__name__)

# Sarvam speech-to-text default model (saaras family, code-switch capable).
DEFAULT_SARVAM_MODEL = "saaras:v4"
# The provider key under which a per-tenant override arrives (gateway wire).
SARVAM_OVERRIDE_KEY = "sarvam"


class SarvamLoader(BaseModelLoader):
    """Loader for Sarvam AI speech-to-text (cloud REST)."""

    @property
    def supported_formats(self) -> list[AiModelFormat]:
        return [AiModelFormat.SARVAM]

    async def load(
        self,
        model_config: AiModelConfig,
        provider_overrides: dict[str, object] | None = None,
    ) -> LoadedModel:
        """Validate the key and return a ``CloudRestConfig`` handle.

        Args:
            model_config: Model configuration (from DB slug or inline YAML).
            provider_overrides: Optional per-tenant credential map (gateway
                wire shape). The ``sarvam`` entry, when present, takes
                precedence over env credentials.

        Raises:
            CloudASRAuthError: when no key is available from either source.
        """
        settings = get_settings()
        override = resolve_override_key(provider_overrides, SARVAM_OVERRIDE_KEY)

        api_key_str = None
        base_url = settings.sarvam_base_url
        model_name = model_config.source_uri or DEFAULT_SARVAM_MODEL
        used_override = False

        if override:
            api_key_str = override.get("api_key") or None
            base_url = override.get("base_url") or base_url
            model_name = override.get("model") or model_name
            used_override = bool(api_key_str)

        if not api_key_str:
            raise CloudASRAuthError(
                "Sarvam credentials not configured. Sarvam is BYOK-only: configure "
                "a tenant Sarvam credential, or the platform (SYSTEM-tenant) Sarvam "
                "connection, in the provider-connection plane. There is no env fallback.",
                details={"has_key": False, "provider": "sarvam"},
            )

        config = CloudRestConfig(
            provider="sarvam",
            api_key=SecretStr(api_key_str),
            base_url=base_url,
            model_name=model_name,
            language_default=None,
        )

        logger.info(
            "Sarvam config created (model=%s, base_url=%s, byok=%s, model_slug=%s)",
            model_name,
            base_url,
            used_override,
            model_config.slug,
        )

        return LoadedModel(
            model_id=model_config.id,
            model_slug=model_config.slug,
            model=config,
            tokenizer=None,
            processor=None,
            feature_extractor=None,
            format=AiModelFormat.SARVAM,
            memory_mb=0,
            device="cloud",
            extra={"is_cloud": True, "provider": "sarvam"},
        )

    async def unload(self, loaded_model: LoadedModel) -> None:
        loaded_model.model = None
        logger.info("Sarvam handle released: %s", loaded_model.model_slug)

    def estimate_memory(self, model_config: AiModelConfig) -> int:
        return 0
