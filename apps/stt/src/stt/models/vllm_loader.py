"""`vllm` speech-to-text loader (TASK-1021, contract C-5).

The in-cluster ``vllm`` service (``apps/vllm``, contract C-3) decodes Whisper
windows behind the OpenAI transcription schema, ``POST {base_url}/audio/transcriptions``.
This process holds no weights for it, so there is nothing to download, cache or
evict: the loader turns the gateway-injected ``provider_overrides["vllm"]`` entry —
the SYSTEM ``AiProviderConnection(stt, vllm)`` row, or a tenant sibling under
``vllm:<slug>`` — into a :class:`VllmAsrConfig`, and fails CLOSED by name when the
entry is absent.

No vendor credential exists: the service is platform hardware, so the loader is
``SELF_HOSTED`` and outbound calls authenticate with this service's own
``INTERNAL_ACCESS_TOKEN`` as ``X-Service-Token`` (decision D-10). Transcription is
done by ``streaming/vllm_asr.py``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import structlog

from ..core.exceptions import ModelLoadError
from ..pipeline.dto import AiModelConfig, AiModelFormat
from .base_loader import BaseModelLoader, CredentialPosture, LoadedModel
from .cloud_asr import resolve_override_key

logger = structlog.get_logger(__name__)

#: The `AiModel.libraryName` a vLLM-served row declares, and the provider id its
#: SYSTEM connection is keyed under on the `provider_overrides` wire.
VLLM_LIBRARY = "vllm"
VLLM_OVERRIDE_KEY = "vllm"
#: Per-request timeout when the connection declares none (contract C-5 `timeout_s?`).
DEFAULT_VLLM_TIMEOUT_S = 30.0


@dataclass(frozen=True)
class VllmAsrConfig:
    """Where and how to reach the `vllm` service for one model. Held in ``LoadedModel.model``."""

    base_url: str  # e.g. http://hope-vllm-asr:8867/v1
    model_slug: str  # the AiModel slug — sent as the OpenAI `model` field
    max_concurrent: int | None  # per-process in-flight cap for this base_url; None = unbounded
    timeout_s: float


def is_vllm_served(model_config: Any) -> bool:
    """Whether a model config names the `vllm` serving library.

    A vLLM row keeps its artifact ``format`` (``SAFETENSOR``); the SELECTION key is
    ``libraryName`` (TASK-944 B2), so the pre-load decisions that branch on the
    engine read the library, not the format.
    """
    library = getattr(model_config, "library_name", None)
    return isinstance(library, str) and library.strip() == VLLM_LIBRARY


class VllmLoader(BaseModelLoader):
    """Loader for Whisper served by the in-cluster `vllm` service (REST, no weights)."""

    # Platform hardware: there is no vendor key to fail closed on, and none may be
    # declared. The connection entry carries WHERE to call, never a secret.
    credential_posture = CredentialPosture.SELF_HOSTED
    override_key = None

    @property
    def supported_formats(self) -> list[AiModelFormat]:
        return [AiModelFormat.VLLM]

    async def load(
        self,
        model_config: AiModelConfig,
        provider_overrides: dict[str, object] | None = None,
    ) -> LoadedModel:
        """Build the :class:`VllmAsrConfig` from the connection entry.

        Raises:
            ModelLoadError: when no enabled `vllm` connection reached this call.
        """
        entry = resolve_override_key(
            provider_overrides,
            VLLM_OVERRIDE_KEY,
            connection_key=model_config.connection_key,
        )
        base_url = entry.get("base_url") if entry else None
        if not isinstance(base_url, str) or not base_url.strip():
            raise ModelLoadError(
                "vllm connection not configured: enable the SYSTEM "
                "AiProviderConnection(stt, vllm) with its baseUrl",
                details={
                    "model_slug": model_config.slug,
                    "connection_key": model_config.connection_key or VLLM_OVERRIDE_KEY,
                    "has_entry": entry is not None,
                },
            )
        assert entry is not None  # narrowed by the base_url check above

        raw_max = entry.get("max_concurrent")
        max_concurrent = (
            int(raw_max)
            if isinstance(raw_max, (int, float)) and not isinstance(raw_max, bool) and raw_max > 0
            else None
        )
        raw_timeout = entry.get("timeout_s")
        timeout_s = (
            float(raw_timeout)
            if isinstance(raw_timeout, (int, float))
            and not isinstance(raw_timeout, bool)
            and raw_timeout > 0
            else DEFAULT_VLLM_TIMEOUT_S
        )
        config = VllmAsrConfig(
            base_url=base_url.strip(),
            model_slug=model_config.slug,
            max_concurrent=max_concurrent,
            timeout_s=timeout_s,
        )
        logger.info(
            "stt.vllm.model_bound",
            model_slug=model_config.slug,
            base_url=config.base_url,
            max_concurrent=max_concurrent,
            timeout_s=timeout_s,
        )
        return LoadedModel(
            model_id=model_config.id,
            model_slug=model_config.slug,
            model=config,
            format=AiModelFormat.VLLM,
            memory_mb=0,
            device="remote",
            extra={"is_remote": True, "provider": VLLM_OVERRIDE_KEY},
        )

    async def unload(self, loaded_model: LoadedModel) -> None:
        loaded_model.model = None

    def estimate_memory(self, model_config: AiModelConfig) -> int:
        return 0
