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

Credentials come from settings only (no ``compute_type`` smuggling — the
AZURE_SPEECH ``"key:"`` wart is deliberately not repeated).
"""

import logging

from ..core.config.settings import get_settings
from ..core.exceptions import CloudASRAuthError
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

        # Per-tenant BYOK override (TASK-567): the `azure-speech` credential row
        # carries the Foundry endpoint/key too (a Foundry resource IS an Azure
        # Speech resource). Override wins over env; env fallback preserved.
        override = None
        if provider_overrides:
            entry = provider_overrides.get("azure-speech")
            if isinstance(entry, dict) and entry:
                override = entry

        endpoint = (
            (override.get("endpoint") if override else None)
            or settings.azure_foundry_endpoint
            or ""
        ).rstrip("/")
        api_key = (
            (override.get("api_key") if override else None)
            or (
                settings.azure_foundry_api_key.get_secret_value()
                if settings.azure_foundry_api_key
                else None
            )
        )
        if not endpoint or not api_key:
            raise CloudASRAuthError(
                "Azure Foundry credentials missing: set AZURE_FOUNDRY_ENDPOINT "
                "and AZURE_FOUNDRY_API_KEY"
            )

        # The pipeline's model id (e.g. "mai-transcribe-1.5" from
        # `azure-foundry :: mai-transcribe-1.5`) wins over the settings default.
        model_name = model_config.source_uri or settings.azure_foundry_model

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
