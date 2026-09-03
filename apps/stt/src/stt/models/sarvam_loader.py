"""Sarvam AI speech-to-text loader (cloud REST ASR engine).

Like the Azure Speech loader this downloads no weights: it resolves
the API key from the gateway-injected ``provider_overrides`` entry (tenant ->
SYSTEM ``AiProviderConnection``) and returns a lightweight ``LoadedModel`` whose ``.model`` is a :class:`CloudRestConfig`.
Actual transcription is performed by ``streaming/sarvam_asr.py`` (per-utterance,
streaming) and ``BatchTranscriptionService._run_sarvam_inference`` (batch).

Security: the key is never logged. Only region-free, non-secret fields
(base_url, model, slug) appear in log lines.
"""

import logging

from pydantic import SecretStr

from ..core.config.settings import get_settings
from ..core.exceptions import CloudASRAuthError, ModelNotFoundError
from ..pipeline.dto import AiModelConfig, AiModelFormat
from .base_loader import BaseModelLoader, CredentialPosture, LoadedModel
from .cloud_asr import CloudRestConfig, resolve_override_key

logger = logging.getLogger(__name__)

# There is deliberately NO `DEFAULT_SARVAM_MODEL` here (lane C,
# assessment F-11). It used to be `"saaras:v4"` and was substituted whenever the
# resolved `AiModel` row carried no `source_uri` — a hardcoded SELECTION, which
# rule 09 forbids outright, and one that reached the wire under a tenant's own
# BYO key. Selection is `failMode: 'closed'`: the row's `source_uri` (or an
# explicit per-request `model` override) is the only authority, and its absence
# raises rather than picking a model on the caller's behalf.
#
# The provider key under which a per-tenant override arrives (gateway wire).
SARVAM_OVERRIDE_KEY = "sarvam"


class SarvamLoader(BaseModelLoader):
    """Loader for Sarvam AI speech-to-text (cloud REST)."""

    # Cloud vendor credential REQUIRED; it arrives per request as a
    # gateway-injected `provider_overrides` entry (tenant -> SYSTEM
    # AiProviderConnection) read under `override_key`. There is no env fallback.
    credential_posture = CredentialPosture.BYOK
    override_key = SARVAM_OVERRIDE_KEY

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
        model_name = model_config.source_uri
        used_override = False

        if override:
            api_key_str = override.get("api_key") or None
            base_url = override.get("base_url") or base_url
            model_name = override.get("model") or model_name
            used_override = bool(api_key_str)

        # FAIL CLOSED on an unresolved selection, and do it BEFORE the
        # credential check so the operator is told which of the two is missing.
        if not model_name:
            raise ModelNotFoundError(
                "No Sarvam model is selected: the resolved AiModel row carries no "
                "source_uri and the request supplied no model override.",
                details={"provider": SARVAM_OVERRIDE_KEY, "slug": model_config.slug},
            )

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
