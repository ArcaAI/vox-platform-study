"""OpenAI speech-to-text loader (cloud REST ASR engine).

Mirrors :mod:`stt.models.sarvam_loader`: downloads no weights,
resolves the API key (per-tenant override first, then ``OPENAI_API_KEY`` env),
and returns a ``LoadedModel`` whose ``.model`` is a :class:`CloudRestConfig`.
``base_url`` supports Azure-OpenAI-compatible endpoints. Transcription is done
by ``streaming/openai_asr.py`` and
``BatchTranscriptionService._run_openai_inference`` via REST
``POST {base_url}/audio/transcriptions``.

Security: the key is never logged.
"""

import logging

from pydantic import SecretStr

from ..core.config.settings import get_settings
from ..core.exceptions import CloudASRAuthError
from ..pipeline.dto import AiModelConfig, AiModelFormat
from .base_loader import BaseModelLoader, LoadedModel
from .cloud_asr import CloudRestConfig, resolve_override_key

logger = logging.getLogger(__name__)

# OpenAI speech-to-text default model (better WER than whisper-1;
# gpt-4o-mini-transcribe is the latency-optimized sibling).
DEFAULT_OPENAI_MODEL = "gpt-4o-transcribe"
# The provider key under which a per-tenant override arrives (gateway wire).
OPENAI_OVERRIDE_KEY = "openai"


class OpenAILoader(BaseModelLoader):
    """Loader for OpenAI speech-to-text (cloud REST)."""

    @property
    def supported_formats(self) -> list[AiModelFormat]:
        return [AiModelFormat.OPENAI]

    async def load(
        self,
        model_config: AiModelConfig,
        provider_overrides: dict[str, object] | None = None,
    ) -> LoadedModel:
        """Validate the key and return a ``CloudRestConfig`` handle.

        Args:
            model_config: Model configuration (from DB slug or inline YAML).
            provider_overrides: Optional per-tenant credential map (gateway
                wire shape). The ``openai`` entry, when present, takes
                precedence over env credentials.

        Raises:
            CloudASRAuthError: when no key is available from either source.
        """
        settings = get_settings()
        override = resolve_override_key(provider_overrides, OPENAI_OVERRIDE_KEY)

        api_key_str = None
        base_url = settings.openai_base_url
        model_name = model_config.source_uri or DEFAULT_OPENAI_MODEL
        used_override = False

        if override:
            api_key_str = override.get("api_key") or None
            base_url = override.get("base_url") or base_url
            model_name = override.get("model") or model_name
            used_override = bool(api_key_str)

        if not api_key_str:
            raise CloudASRAuthError(
                "OpenAI credentials not configured. OpenAI ASR is BYOK-only: configure "
                "a tenant OpenAI credential, or the platform (SYSTEM-tenant) OpenAI "
                "connection, in the provider-connection plane. There is no env fallback.",
                details={"has_key": False, "provider": "openai"},
            )

        config = CloudRestConfig(
            provider="openai",
            api_key=SecretStr(api_key_str),
            base_url=base_url,
            model_name=model_name,
            language_default=None,
        )

        logger.info(
            "OpenAI config created (model=%s, base_url=%s, byok=%s, model_slug=%s)",
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
            format=AiModelFormat.OPENAI,
            memory_mb=0,
            device="cloud",
            extra={"is_cloud": True, "provider": "openai"},
        )

    async def unload(self, loaded_model: LoadedModel) -> None:
        loaded_model.model = None
        logger.info("OpenAI handle released: %s", loaded_model.model_slug)

    def estimate_memory(self, model_config: AiModelConfig) -> int:
        return 0
