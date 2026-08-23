"""Azure AI Foundry (MAI-Transcribe) loader — cloud ASR engine.

Like :mod:`azure_speech_loader`, no model artifact is downloaded: the loader
validates configuration and returns a lightweight ``LoadedModel`` whose
``model`` carries the REST connection details for
``POST {endpoint}/speechtotext/transcriptions:transcribe`` (the LLM Speech
API with ``enhancedMode``). Inference lives in
``BatchTranscriptionService._run_azure_foundry_inference``.

MAI-Transcribe is a PREVIEW service (no SLA, no diarization) — the engine is
DISABLED unless ``azure_foundry_enabled`` is set, and it is batch-only. Do not
route PHI until GA + data-residency sign-off.

The API key is BYOK-only — it comes solely from the per-tenant / SYSTEM
provider-connection override, never from env (no ``compute_type`` smuggling
either — the AZURE_SPEECH ``"key:"`` wart is deliberately not repeated).
"""

import logging

from ..core.config.settings import get_settings
from ..core.exceptions import CloudASRAuthError, ConfigurationError
from ..pipeline.dto import AiModelConfig, AiModelFormat
from .base_loader import BaseModelLoader, LoadedModel

logger = logging.getLogger(__name__)


class AzureFoundryLoader(BaseModelLoader):
    """Loader for the Azure AI Foundry LLM Speech API (MAI-Transcribe)."""

    @property
    def supported_formats(self) -> list[AiModelFormat]:
        return [AiModelFormat.AZURE_FOUNDRY]

    async def load(
        self,
        model_config: AiModelConfig,
        provider_overrides: dict[str, object] | None = None,
    ) -> LoadedModel:
        settings = get_settings()

        if not settings.azure_foundry_enabled:
            raise CloudASRAuthError(
                "Azure Foundry (MAI-Transcribe) engine is disabled "
                "(azure_foundry_enabled=false). Decision D4: preview service — "
                "enable explicitly once GA + data residency are signed off."
            )

        # Per-tenant BYOK override: the `azure-speech` credential row
        # carries the Foundry endpoint/key too (a Foundry resource IS an Azure
        # Speech resource).
        override = None
        if provider_overrides:
            entry = provider_overrides.get("azure-speech")
            if isinstance(entry, dict) and entry:
                override = entry

        # Azure Foundry is BYOK-only, exactly like Azure Speech: the API KEY comes
        # solely from the per-tenant / SYSTEM provider-connection override (there is
        # no env fallback). `azure.foundryApiKey` was ALREADY a registered vault-kv
        # platform-secret descriptor — the governance existed and this reader simply
        # never asked for it, reading `AZURE_FOUNDRY_API_KEY` from env instead. The
        # ENDPOINT is non-secret, so its env fallback legitimately stays.
        api_key = override.get("api_key") if override else None

        endpoint = (
            (override.get("endpoint") if override else None)
            or settings.azure_foundry_endpoint
            or ""
        ).rstrip("/")

        if not endpoint or not api_key:
            raise CloudASRAuthError(
                "Azure Foundry credentials not configured. Azure Foundry is BYOK-only: "
                "configure a tenant Azure Speech credential, or the platform "
                "(SYSTEM-tenant) connection, in the provider-connection plane (the "
                "endpoint may still be set via AZURE_FOUNDRY_ENDPOINT). There is no "
                "env fallback for the key.",
                details={
                    "has_key": bool(api_key),
                    "has_endpoint": bool(endpoint),
                },
            )

        # Model SELECTION is fail-closed: the pipeline's resolved model id (e.g.
        # from `azure-foundry :: mai-transcribe-1.5`) is the ONLY source. A code
        # literal here would silently transcribe on a model nobody selected.
        model_name = model_config.source_uri
        if not model_name:
            raise ConfigurationError(
                "Azure Foundry model not resolved: the pipeline's AiModel carries no "
                "source_uri. The MAI transcription model is tenant/platform "
                "configuration and has no code default — configure it on the model "
                "row rather than relying on a fallback.",
                details={"model_slug": model_config.slug},
            )

        from datetime import UTC, datetime

        logger.info("Azure Foundry MAI engine configured (model=%s)", model_name)
        return LoadedModel(
            model_id=model_config.id,
            model_slug=model_config.slug,
            model={
                "endpoint": endpoint,
                "api_key": api_key,
                "model": model_name,
            },
            processor=None,
            tokenizer=None,
            format=AiModelFormat.AZURE_FOUNDRY,
            memory_mb=0,
            device="cloud",
            loaded_at=datetime.now(UTC),
            extra={"provider": "azure_foundry"},
        )

    async def unload(self, loaded_model: LoadedModel) -> None:
        # Nothing to release — connection details only.
        return None

    def estimate_memory(self, model_config: AiModelConfig) -> int:
        return 0
