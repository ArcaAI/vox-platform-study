"""Azure AI Foundry (MAI-Transcribe) loader — cloud ASR engine.

Like :mod:`azure_speech_loader`, no model artifact is downloaded: the loader
validates configuration and returns a lightweight ``LoadedModel`` whose
``model`` carries the REST connection details for
``POST {endpoint}/speechtotext/transcriptions:transcribe`` (the LLM Speech
API with ``enhancedMode``). Inference lives in
``BatchTranscriptionService._run_azure_foundry_inference``.

MAI-Transcribe is a PREVIEW service (no SLA, no diarization) and batch-only. Do not
route PHI until GA + data-residency sign-off.

TASK-880 — the engine's gate is its own ``AiProviderConnection(stt, azure-foundry)``
row, not the platform flag ``stt.azureFoundry.enabled`` it replaces. The three-state
row semantics ARE the gate the flag was imitating, and better: **no row** or a
disabled/keyless one means no ``provider_overrides`` entry is injected, so the engine
cannot load; the SYSTEM row seeds ``enabled: false``, which is the platform's
preview veto; a tenant that has signed off brings its own credential and enables it,
per tenant, instead of flipping one boolean for the whole platform. The endpoint rides
the same row (``baseUrl``), replacing ``stt.azureFoundry.endpoint``.

Foundry has its OWN connection row rather than aliasing ``azure-speech``. It used to
read the ``azure-speech`` entry on the reasoning that a Foundry resource IS an Azure
Speech resource — but that made one credential the gate for two engines with different
data-residency postures, so a tenant could not enable Speech without also enabling a
PREVIEW service for its PHI, and could not point Foundry at a different resource.

The API key is BYOK-only — it comes solely from the per-tenant / SYSTEM
provider-connection override, never from env (no ``compute_type`` smuggling
either — the AZURE_SPEECH ``"key:"`` wart is deliberately not repeated).
"""

import logging

from ..core.exceptions import CloudASRAuthError, ConfigurationError
from ..pipeline.dto import AiModelConfig, AiModelFormat
from .base_loader import BaseModelLoader, CredentialPosture, LoadedModel
from .cloud_asr import resolve_override_key

logger = logging.getLogger(__name__)


class AzureFoundryLoader(BaseModelLoader):
    """Loader for the Azure AI Foundry LLM Speech API (MAI-Transcribe)."""

    # Cloud vendor credential REQUIRED; it arrives per request as a
    # gateway-injected `provider_overrides` entry (tenant -> SYSTEM
    # AiProviderConnection) read under `override_key`. There is no env fallback.
    credential_posture = CredentialPosture.BYOK
    override_key = "azure-foundry"

    @property
    def supported_formats(self) -> list[AiModelFormat]:
        return [AiModelFormat.AZURE_FOUNDRY]

    async def load(
        self,
        model_config: AiModelConfig,
        provider_overrides: dict[str, object] | None = None,
    ) -> LoadedModel:
        # TASK-880 — the row IS the gate. An entry under `azure-foundry` exists only
        # when an enabled, keyed `AiProviderConnection(stt, azure-foundry)` resolved for
        # this tenant (tenant row, else the SYSTEM row, neither vetoed); absent means no
        # tier serves the engine, which is exactly what the deleted
        # `stt.azureFoundry.enabled` flag expressed — now per tenant rather than per
        # platform, and defaulting to the same OFF via the seeded disabled SYSTEM row.
        #
        # TASK-958 — read under the model's own `connection_key` first, the provider id
        # second (see `resolve_override_key`), so a tenant with two Foundry resources
        # reaches the one its agent bound.
        override = resolve_override_key(
            provider_overrides,
            self.override_key,
            connection_key=model_config.connection_key,
        )

        # Azure Foundry is BYOK-only, exactly like Azure Speech: the API KEY comes
        # solely from the per-tenant / SYSTEM provider-connection override (there is
        # no env fallback). `azure.foundryApiKey` was ALREADY a registered vault-kv
        # platform-secret descriptor — the governance existed and this reader simply
        # never asked for it, reading `AZURE_FOUNDRY_API_KEY` from env instead.
        #
        # TASK-880 — the ENDPOINT comes from the same row (`baseUrl` on the wire), not
        # from `stt.azureFoundry.endpoint`. `endpoint` is accepted as the pre-unification
        # `extraJson` spelling so a row written before the column existed still loads.
        api_key = override.get("api_key") if override else None

        endpoint = (
            (override.get("base_url") or override.get("endpoint") if override else None) or ""
        ).rstrip("/")

        if not endpoint or not api_key:
            raise CloudASRAuthError(
                "Azure Foundry (MAI-Transcribe) is not available for this tenant. It is "
                "BYOK-only and PREVIEW: configure an `azure-foundry` connection — the "
                "tenant's own, or the platform (SYSTEM-tenant) row — in the "
                "provider-connection plane, ENABLED, with both a key and a `baseUrl`. "
                "The SYSTEM row ships disabled on purpose: do not route PHI until GA "
                "and data-residency sign-off. There is no env fallback for either half.",
                details={
                    "has_key": bool(api_key),
                    "has_endpoint": bool(endpoint),
                    "provider": self.override_key,
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
